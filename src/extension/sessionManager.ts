import * as crypto from "node:crypto";
import * as os from "node:os";
import WebSocket from "ws";
import * as vscode from "vscode";
import { TextCrdt } from "../crdt/textCrdt";
import { CrdtOperation } from "../crdt/types";
import { RelayServer } from "../server/relayServer";
import { ClientMessage, ServerMessage } from "../shared/messages";
import { changesToOperations, replaceDocumentText } from "./documentAdapter";
import { StatusBarController } from "./statusBar";

type SessionConfig = {
  roomId: string;
  serverUrl: string;
  document: vscode.TextDocument;
  seedText: string;
};

export class SessionManager implements vscode.Disposable {
  private readonly clientId = `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
  private readonly statusBar = new StatusBarController();
  private readonly output = vscode.window.createOutputChannel("LiveShare Lite");
  private readonly disposables: vscode.Disposable[] = [];
  private localChangeSubscription?: vscode.Disposable;
  private localServer?: RelayServer;
  private ws?: WebSocket;
  private crdt?: TextCrdt;
  private session?: SessionConfig;
  private applyingRemoteChange = false;
  private connected = false;
  private seedSent = false;
  private reconnectTimer?: NodeJS.Timeout;
  private offlineQueue: CrdtOperation[] = [];
  private peerCount = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(this.statusBar, this.output);
    this.context.subscriptions.push(this);
  }

  async startServer(): Promise<void> {
    if (this.localServer) {
      vscode.window.showInformationMessage(`LiveShare Lite server already running on port ${this.localServer.port()}.`);
      return;
    }

    const configuredPort = vscode.workspace.getConfiguration("liveshareLite").get<number>("serverPort", 7071);
    const input = await vscode.window.showInputBox({
      title: "LiveShare Lite relay port",
      value: String(configuredPort),
      validateInput: (value) => (Number.isInteger(Number(value)) ? undefined : "Port must be a number.")
    });

    if (!input) {
      return;
    }

    this.localServer = new RelayServer({ port: Number(input), host: "127.0.0.1" });
    const port = await this.localServer.start();
    vscode.window.showInformationMessage(`LiveShare Lite relay server started on ws://127.0.0.1:${port}`);
  }

  async startSession(): Promise<void> {
    const editor = await this.requireActiveEditor();
    if (!editor) {
      return;
    }

    const roomId = await this.promptRoomId(randomRoomId());
    if (!roomId) {
      return;
    }

    const serverUrl = await this.promptServerUrl();
    if (!serverUrl) {
      return;
    }

    await this.connect({
      roomId,
      serverUrl,
      document: editor.document,
      seedText: editor.document.getText()
    });
  }

  async joinSession(): Promise<void> {
    const editor = await this.requireActiveEditor();
    if (!editor) {
      return;
    }

    const roomId = await this.promptRoomId();
    if (!roomId) {
      return;
    }

    const serverUrl = await this.promptServerUrl();
    if (!serverUrl) {
      return;
    }

    await this.connect({
      roomId,
      serverUrl,
      document: editor.document,
      seedText: editor.document.getText()
    });
  }

  async leaveSession(showMessage = true): Promise<void> {
    this.clearReconnectTimer();
    this.localChangeSubscription?.dispose();
    this.localChangeSubscription = undefined;

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    this.connected = false;
    this.session = undefined;
    this.crdt = undefined;
    this.offlineQueue = [];
    this.seedSent = false;
    this.peerCount = 0;
    this.statusBar.setState("idle");

    if (showMessage) {
      vscode.window.showInformationMessage("LiveShare Lite session left.");
    }
  }

  showDebugState(): void {
    this.output.show();
    this.output.appendLine("=== LiveShare Lite Debug State ===");
    this.output.appendLine(
      JSON.stringify(
        {
          clientId: this.clientId,
          connected: this.connected,
          roomId: this.session?.roomId,
          serverUrl: this.session?.serverUrl,
          queuedOperations: this.offlineQueue.length,
          crdt: this.crdt?.debugState()
        },
        null,
        2
      )
    );
  }

  async runLocalDemo(): Promise<void> {
    const a = new TextCrdt("A");
    const b = new TextCrdt("B");
    const ops = [...a.insert(0, "hi"), ...b.insert(0, "!")];

    for (const op of [...ops].reverse()) {
      a.applyOperation(op);
      b.applyOperation(op);
    }

    this.output.show();
    this.output.appendLine(`Local CRDT demo converged to: ${JSON.stringify(a.toString())}`);
    vscode.window.showInformationMessage(`LiveShare Lite local CRDT demo: ${JSON.stringify(a.toString())}`);
  }

  dispose(): void {
    void this.leaveSession(false);
    void this.localServer?.stop();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async connect(config: SessionConfig): Promise<void> {
    await this.leaveSession(false);

    this.session = config;
    this.crdt = new TextCrdt(this.clientId);
    this.statusBar.setState("syncing", config.roomId);
    this.localChangeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      void this.handleLocalDocumentChange(event);
    });

    this.openSocket();
  }

  private openSocket(): void {
    if (!this.session) {
      return;
    }

    this.clearReconnectTimer();
    const { serverUrl, roomId } = this.session;
    this.output.appendLine(`Connecting to ${serverUrl} room ${roomId} as ${this.clientId}`);
    this.statusBar.setState("syncing", roomId, this.peerCount);

    const socket = new WebSocket(serverUrl);
    this.ws = socket;

    socket.on("open", () => {
      this.connected = true;
      this.sendRaw({
        type: "join",
        roomId,
        clientId: this.clientId
      });
    });

    socket.on("message", (raw) => {
      void this.handleServerMessage(JSON.parse(raw.toString()) as ServerMessage);
    });

    socket.on("close", () => {
      this.connected = false;
      this.statusBar.setState("disconnected", roomId, this.peerCount);
      this.scheduleReconnect();
    });

    socket.on("error", (error) => {
      this.output.appendLine(`WebSocket error: ${error.message}`);
    });
  }

  private async handleServerMessage(message: ServerMessage): Promise<void> {
    if (!this.session || !this.crdt) {
      return;
    }

    if (message.type === "error") {
      this.output.appendLine(`Relay error: ${message.message}`);
      return;
    }

    if (message.type === "presence") {
      this.peerCount = message.peers.length;
      this.statusBar.setState(this.connected ? "connected" : "disconnected", this.session.roomId, this.peerCount);
      return;
    }

    if (message.type === "joined") {
      this.peerCount = message.peers.length;
      let changed = false;

      for (const op of message.opLog) {
        const before = this.crdt.toString();
        const result = this.crdt.applyOperation(op);
        changed = changed || result.status === "applied" || result.drained > 0 || before !== this.crdt.toString();
      }

      if (!this.seedSent && message.opLog.length === 0 && this.session.seedText.length > 0) {
        const ops = this.crdt.insert(0, this.session.seedText);
        this.seedSent = true;
        for (const op of ops) {
          this.sendOperation(op);
        }
      } else if (changed || message.opLog.length > 0) {
        await this.renderCrdtToDocument();
      }

      this.flushOfflineQueue();
      this.statusBar.setState("connected", this.session.roomId, this.peerCount);
      return;
    }

    if (message.type === "operation") {
      const before = this.crdt.toString();
      const result = this.crdt.applyOperation(message.op);
      this.output.appendLine(`op ${message.op.type} ${result.status} ${JSON.stringify(message.op.opId)}`);

      if (result.status === "applied" || result.drained > 0 || before !== this.crdt.toString()) {
        await this.renderCrdtToDocument();
      }
    }
  }

  private async handleLocalDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (!this.session || !this.crdt || this.applyingRemoteChange) {
      return;
    }

    if (event.document.uri.toString() !== this.session.document.uri.toString()) {
      return;
    }

    try {
      const operations = changesToOperations(event.contentChanges, this.crdt);
      for (const op of operations) {
        this.output.appendLine(`local ${op.type} ${JSON.stringify(op.opId)}`);
        this.sendOperation(op);
      }
    } catch (error) {
      this.output.appendLine(error instanceof Error ? error.message : "Failed to translate local document change.");
      vscode.window.showWarningMessage("LiveShare Lite could not translate a local edit. Use Show Debug State for details.");
    }
  }

  private async renderCrdtToDocument(): Promise<void> {
    if (!this.session || !this.crdt) {
      return;
    }

    const nextText = this.crdt.toString();
    if (this.session.document.getText() === nextText) {
      return;
    }

    this.applyingRemoteChange = true;
    try {
      await replaceDocumentText(vscode, this.session.document, nextText);
    } finally {
      this.applyingRemoteChange = false;
    }
  }

  private sendOperation(operation: CrdtOperation): void {
    if (!this.session) {
      return;
    }

    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      this.offlineQueue.push(operation);
      this.statusBar.setState("disconnected", this.session.roomId, this.peerCount);
      return;
    }

    this.sendRaw({
      type: "operation",
      roomId: this.session.roomId,
      clientId: this.clientId,
      op: operation
    });
  }

  private flushOfflineQueue(): void {
    const queued = this.offlineQueue;
    this.offlineQueue = [];

    for (const op of queued) {
      this.sendOperation(op);
    }
  }

  private sendRaw(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(): void {
    if (!this.session || this.reconnectTimer) {
      return;
    }

    const delay = vscode.workspace.getConfiguration("liveshareLite").get<number>("reconnectDelayMs", 1500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async requireActiveEditor(): Promise<vscode.TextEditor | undefined> {
    if (vscode.window.activeTextEditor) {
      return vscode.window.activeTextEditor;
    }

    const document = await vscode.workspace.openTextDocument({ content: "", language: "plaintext" });
    return vscode.window.showTextDocument(document);
  }

  private async promptRoomId(defaultValue = ""): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: "LiveShare Lite room ID",
      prompt: "Use the same room ID on every collaborating client.",
      value: defaultValue
    });
  }

  private async promptServerUrl(): Promise<string | undefined> {
    const defaultUrl = vscode.workspace.getConfiguration("liveshareLite").get<string>("serverUrl", "ws://127.0.0.1:7071");
    return vscode.window.showInputBox({
      title: "LiveShare Lite server URL",
      value: defaultUrl,
      validateInput: (value) => (value.startsWith("ws://") || value.startsWith("wss://") ? undefined : "Use ws:// or wss://")
    });
  }
}

function randomRoomId(): string {
  return crypto.randomBytes(3).toString("hex");
}
