import * as crypto from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import { TextCrdt } from "../crdt/textCrdt";
import { CrdtOperation } from "../crdt/types";
import { RelayServer } from "../server/relayServer";
import { SignalingServer } from "../server/signalingServer";
import { P2PMeshTransport } from "../transport/p2pMeshTransport";
import { RelayTransport } from "../transport/relayTransport";
import {
  CollaborationTransport,
  TransportJoinedEvent,
  TransportMode,
  TransportOperationEvent,
  TransportSnapshotEvent
} from "../transport/types";
import { changesToOperations, replaceDocumentText } from "./documentAdapter";
import { StatusBarController } from "./statusBar";

type SessionConfig = {
  roomId: string;
  transportMode: TransportMode;
  connectionUrl: string;
  document: vscode.TextDocument;
  seedText: string;
};

type LocalServer = {
  start(): Promise<number>;
  port(): number;
  stop(): Promise<void>;
};

export class SessionManager implements vscode.Disposable {
  private readonly clientId = `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
  private readonly statusBar = new StatusBarController();
  private readonly output = vscode.window.createOutputChannel("LiveShare Lite");
  private readonly disposables: vscode.Disposable[] = [];
  private localChangeSubscription?: vscode.Disposable;
  private localServer?: LocalServer;
  private localServerKind?: "relay" | "signaling";
  private transport?: CollaborationTransport;
  private crdt?: TextCrdt;
  private session?: SessionConfig;
  private applyingRemoteChange = false;
  private connected = false;
  private syncReady = false;
  private seedSent = false;
  private reconnectTimer?: NodeJS.Timeout;
  private offlineQueue: CrdtOperation[] = [];
  private pendingRemoteOperations: TransportOperationEvent[] = [];
  private pendingSnapshotRequests = new Set<string>();
  private peerCount = 0;
  private snapshotProviderPeerId?: string;
  private snapshotRequested = false;
  private syncPendingWarningShown = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(this.statusBar, this.output);
    this.context.subscriptions.push(this);
  }

  async startServer(): Promise<void> {
    if (this.localServer) {
      vscode.window.showInformationMessage(
        `LiveShare Lite ${this.localServerKind} server already running on port ${this.localServer.port()}.`
      );
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
    this.localServerKind = "relay";
    const port = await this.localServer.start();
    vscode.window.showInformationMessage(`LiveShare Lite relay server started on ws://127.0.0.1:${port}`);
  }

  async startSignalingServer(): Promise<void> {
    if (this.localServer) {
      vscode.window.showInformationMessage(
        `LiveShare Lite ${this.localServerKind} server already running on port ${this.localServer.port()}.`
      );
      return;
    }

    const configuredPort = vscode.workspace.getConfiguration("liveshareLite").get<number>("signalingPort", 7072);
    const input = await vscode.window.showInputBox({
      title: "LiveShare Lite signaling port",
      value: String(configuredPort),
      validateInput: (value) => (Number.isInteger(Number(value)) ? undefined : "Port must be a number.")
    });

    if (!input) {
      return;
    }

    this.localServer = new SignalingServer({ port: Number(input), host: "127.0.0.1" });
    this.localServerKind = "signaling";
    const port = await this.localServer.start();
    vscode.window.showInformationMessage(`LiveShare Lite signaling server started on ws://127.0.0.1:${port}`);
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

    const transportMode = this.configuredTransportMode();
    const connectionUrl = await this.promptConnectionUrl(transportMode);
    if (!connectionUrl) {
      return;
    }

    await this.connect({
      roomId,
      transportMode,
      connectionUrl,
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

    const transportMode = this.configuredTransportMode();
    const connectionUrl = await this.promptConnectionUrl(transportMode);
    if (!connectionUrl) {
      return;
    }

    await this.connect({
      roomId,
      transportMode,
      connectionUrl,
      document: editor.document,
      seedText: editor.document.getText()
    });
  }

  async leaveSession(showMessage = true): Promise<void> {
    this.clearReconnectTimer();
    this.localChangeSubscription?.dispose();
    this.localChangeSubscription = undefined;

    const transport = this.transport;
    this.transport = undefined;
    transport?.close();

    this.connected = false;
    this.syncReady = false;
    this.session = undefined;
    this.crdt = undefined;
    this.offlineQueue = [];
    this.pendingRemoteOperations = [];
    this.pendingSnapshotRequests.clear();
    this.seedSent = false;
    this.peerCount = 0;
    this.snapshotProviderPeerId = undefined;
    this.snapshotRequested = false;
    this.syncPendingWarningShown = false;
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
          syncReady: this.syncReady,
          transportMode: this.session?.transportMode,
          roomId: this.session?.roomId,
          connectionUrl: this.session?.connectionUrl,
          queuedOperations: this.offlineQueue.length,
          pendingRemoteOperations: this.pendingRemoteOperations.length,
          pendingSnapshotRequests: this.pendingSnapshotRequests.size,
          snapshotProviderPeerId: this.snapshotProviderPeerId,
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

    this.openTransport();
  }

  private openTransport(): void {
    if (!this.session) {
      return;
    }

    this.clearReconnectTimer();
    this.transport?.close();

    const transport = this.createTransport();
    this.transport = transport;
    this.output.appendLine(
      `Connecting via ${this.session.transportMode} to ${this.session.connectionUrl} room ${this.session.roomId} as ${this.clientId}`
    );
    this.statusBar.setState("syncing", this.session.roomId, this.peerCount);
    transport.connect();
  }

  private createTransport(): CollaborationTransport {
    if (!this.session) {
      throw new Error("Cannot create transport without a session.");
    }

    const handlers = {
      onJoined: (event: TransportJoinedEvent) => this.handleTransportJoined(event),
      onPresence: (peers: { clientId: string; connectedAt: number }[]) => this.handlePresence(peers),
      onOperation: (event: TransportOperationEvent) => this.handleTransportOperation(event),
      onSnapshotRequest: (clientId: string) => this.handleSnapshotRequest(clientId),
      onSnapshot: (event: TransportSnapshotEvent) => this.handleSnapshot(event),
      onPeerChannelOpen: () => this.requestP2PSnapshotIfNeeded(),
      onClose: () => this.handleTransportClose(),
      onError: (message: string) => this.output.appendLine(`Transport error: ${message}`),
      log: (message: string) => this.output.appendLine(message)
    };

    if (this.session.transportMode === "p2p") {
      return new P2PMeshTransport({
        signalingUrl: this.session.connectionUrl,
        roomId: this.session.roomId,
        clientId: this.clientId,
        iceServers: this.configuredIceServers(),
        handlers
      });
    }

    return new RelayTransport({
      serverUrl: this.session.connectionUrl,
      roomId: this.session.roomId,
      clientId: this.clientId,
      handlers
    });
  }

  private async handleTransportJoined(event: TransportJoinedEvent): Promise<void> {
    if (!this.session || !this.crdt) {
      return;
    }

    this.peerCount = event.peers.length;

    if (this.session.transportMode === "p2p") {
      if (event.existingPeerIds.length === 0) {
        this.seedCrdtFromDocument();
        this.syncReady = true;
        this.connected = true;
        this.flushPendingSnapshotRequests();
        this.statusBar.setState("connected", this.session.roomId, this.peerCount);
        return;
      }

      this.snapshotProviderPeerId = event.existingPeerIds[0];
      this.snapshotRequested = false;
      this.requestP2PSnapshotIfNeeded();
      this.statusBar.setState("syncing", this.session.roomId, this.peerCount);
      return;
    }

    let changed = false;
    for (const op of event.opLog ?? []) {
      const before = this.crdt.toString();
      const result = this.crdt.applyOperation(op);
      changed = changed || result.status === "applied" || result.drained > 0 || before !== this.crdt.toString();
    }

    if (!this.seedSent && (event.opLog ?? []).length === 0) {
      this.seedCrdtFromDocument();
    } else if (changed || (event.opLog ?? []).length > 0) {
      await this.renderCrdtToDocument();
    }

    this.syncReady = true;
    this.connected = true;
    this.flushPendingSnapshotRequests();
    this.flushOfflineQueue();
    this.statusBar.setState("connected", this.session.roomId, this.peerCount);
  }

  private handlePresence(peers: { clientId: string; connectedAt: number }[]): void {
    if (!this.session) {
      return;
    }

    this.peerCount = peers.length;
    if (this.session.transportMode === "p2p" && !this.syncReady) {
      const candidates = peers
        .map((peer) => peer.clientId)
        .filter((clientId) => clientId !== this.clientId)
        .sort((a, b) => a.localeCompare(b));
      if (!this.snapshotProviderPeerId || !candidates.includes(this.snapshotProviderPeerId)) {
        this.snapshotProviderPeerId = candidates[0];
        this.snapshotRequested = false;
        this.requestP2PSnapshotIfNeeded();
      }
    }

    const state = this.connected ? "connected" : this.syncReady ? "connected" : "syncing";
    this.statusBar.setState(state, this.session.roomId, this.peerCount);
  }

  private async handleTransportOperation(event: TransportOperationEvent): Promise<void> {
    if (!this.session || !this.crdt) {
      return;
    }

    if (this.session.transportMode === "p2p" && !this.syncReady) {
      this.pendingRemoteOperations.push(event);
      return;
    }

    const before = this.crdt.toString();
    const alreadySeen = this.crdt.hasSeen(event.op);
    const result = this.crdt.applyOperation(event.op);
    this.output.appendLine(`op ${event.op.type} ${result.status} ${JSON.stringify(event.op.opId)}`);

    if (this.session.transportMode === "p2p" && !alreadySeen) {
      this.transport?.sendOperation(event.op, event.sourceClientId);
    }

    if (result.status === "applied" || result.drained > 0 || before !== this.crdt.toString()) {
      await this.renderCrdtToDocument();
    }
  }

  private async handleSnapshotRequest(clientId: string): Promise<void> {
    if (!this.crdt) {
      return;
    }

    if (!this.syncReady) {
      this.pendingSnapshotRequests.add(clientId);
      return;
    }

    this.transport?.sendSnapshot?.(clientId, this.crdt.snapshot());
  }

  private async handleSnapshot(event: TransportSnapshotEvent): Promise<void> {
    if (!this.session || this.session.transportMode !== "p2p" || this.syncReady) {
      return;
    }

    this.crdt = TextCrdt.fromSnapshot(event.snapshot, this.clientId);
    this.syncReady = true;
    this.connected = true;
    this.seedSent = true;
    this.flushPendingSnapshotRequests();
    this.output.appendLine(`Applied P2P snapshot from ${event.sourceClientId ?? "peer"}.`);
    await this.renderCrdtToDocument();

    const queued = this.pendingRemoteOperations;
    this.pendingRemoteOperations = [];
    for (const operationEvent of queued) {
      await this.handleTransportOperation(operationEvent);
    }

    this.statusBar.setState("connected", this.session.roomId, this.peerCount);
  }

  private handleTransportClose(): void {
    if (!this.session) {
      return;
    }

    if (this.session.transportMode === "p2p") {
      this.output.appendLine("P2P signaling connection closed.");
      this.statusBar.setState(this.syncReady ? "connected" : "disconnected", this.session.roomId, this.peerCount);
      return;
    }

    this.connected = false;
    this.statusBar.setState("disconnected", this.session.roomId, this.peerCount);
    this.scheduleReconnect();
  }

  private async handleLocalDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (!this.session || !this.crdt || this.applyingRemoteChange) {
      return;
    }

    if (event.document.uri.toString() !== this.session.document.uri.toString()) {
      return;
    }

    if (!this.syncReady) {
      this.output.appendLine("Local edit skipped while initial sync is pending.");
      if (!this.syncPendingWarningShown) {
        this.syncPendingWarningShown = true;
        vscode.window.showWarningMessage("LiveShare Lite is waiting for initial sync before local edits are shared.");
      }
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

  private seedCrdtFromDocument(): void {
    if (!this.session || !this.crdt || this.seedSent) {
      return;
    }

    this.seedSent = true;
    if (this.session.seedText.length === 0) {
      return;
    }

    const ops = this.crdt.insert(0, this.session.seedText);
    for (const op of ops) {
      this.sendOperation(op);
    }
  }

  private sendOperation(operation: CrdtOperation): void {
    if (!this.session) {
      return;
    }

    const sent = this.transport?.sendOperation(operation) ?? false;
    if (!sent && this.session.transportMode === "relay") {
      this.offlineQueue.push(operation);
      this.statusBar.setState("disconnected", this.session.roomId, this.peerCount);
    }
  }

  private flushOfflineQueue(): void {
    if (this.session?.transportMode !== "relay") {
      return;
    }

    const queued = this.offlineQueue;
    this.offlineQueue = [];

    for (const op of queued) {
      this.sendOperation(op);
    }
  }

  private flushPendingSnapshotRequests(): void {
    if (!this.crdt || !this.syncReady) {
      return;
    }

    const clientIds = Array.from(this.pendingSnapshotRequests);
    this.pendingSnapshotRequests.clear();
    for (const clientId of clientIds) {
      this.transport?.sendSnapshot?.(clientId, this.crdt.snapshot());
    }
  }

  private requestP2PSnapshotIfNeeded(): void {
    if (!this.session || this.session.transportMode !== "p2p" || this.syncReady || this.snapshotRequested) {
      return;
    }

    const requested = this.transport?.requestSnapshot?.(this.snapshotProviderPeerId) ?? false;
    if (requested) {
      this.snapshotRequested = true;
    }
  }

  private scheduleReconnect(): void {
    if (!this.session || this.reconnectTimer) {
      return;
    }

    const delay = vscode.workspace.getConfiguration("liveshareLite").get<number>("reconnectDelayMs", 1500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openTransport();
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

  private async promptConnectionUrl(mode: TransportMode): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration("liveshareLite");
    const defaultUrl =
      mode === "p2p"
        ? config.get<string>("signalingUrl", "ws://127.0.0.1:7072")
        : config.get<string>("serverUrl", "ws://127.0.0.1:7071");

    return vscode.window.showInputBox({
      title: mode === "p2p" ? "LiveShare Lite signaling URL" : "LiveShare Lite relay URL",
      value: defaultUrl,
      validateInput: (value) => (value.startsWith("ws://") || value.startsWith("wss://") ? undefined : "Use ws:// or wss://")
    });
  }

  private configuredTransportMode(): TransportMode {
    const mode = vscode.workspace.getConfiguration("liveshareLite").get<string>("transportMode", "relay");
    return mode === "p2p" ? "p2p" : "relay";
  }

  private configuredIceServers(): string[] {
    const fallback = ["stun:stun.l.google.com:19302"];
    const value = vscode.workspace.getConfiguration("liveshareLite").get<unknown>("iceServers", fallback);
    if (!Array.isArray(value)) {
      return fallback;
    }

    const servers = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return servers.length > 0 ? servers : fallback;
  }
}

function randomRoomId(): string {
  return crypto.randomBytes(3).toString("hex");
}
