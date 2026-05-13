import WebSocket from "ws";
import { CrdtOperation } from "../crdt/types";
import { ClientMessage, ServerMessage } from "../shared/messages";
import { CollaborationTransport, TransportHandlers } from "./types";

export type RelayTransportOptions = {
  serverUrl: string;
  roomId: string;
  clientId: string;
  handlers: TransportHandlers;
};

export class RelayTransport implements CollaborationTransport {
  private socket?: WebSocket;
  private disposed = false;

  constructor(private readonly options: RelayTransportOptions) {}

  connect(): void {
    this.disposed = false;
    const socket = new WebSocket(this.options.serverUrl);
    this.socket = socket;

    socket.on("open", () => {
      this.sendRaw({
        type: "join",
        roomId: this.options.roomId,
        clientId: this.options.clientId
      });
    });

    socket.on("message", (raw) => {
      try {
        void this.handleMessage(JSON.parse(raw.toString()) as ServerMessage);
      } catch (error) {
        this.options.handlers.onError?.(error instanceof Error ? error.message : "Invalid relay message.");
      }
    });

    socket.on("close", () => {
      if (!this.disposed) {
        this.options.handlers.onClose?.();
      }
    });

    socket.on("error", (error) => {
      this.options.handlers.onError?.(error.message);
    });
  }

  close(): void {
    this.disposed = true;
    this.socket?.close();
    this.socket = undefined;
  }

  sendOperation(operation: CrdtOperation): boolean {
    return this.sendRaw({
      type: "operation",
      roomId: this.options.roomId,
      clientId: this.options.clientId,
      op: operation
    });
  }

  private async handleMessage(message: ServerMessage): Promise<void> {
    if (message.type === "error") {
      this.options.handlers.onError?.(message.message);
      return;
    }

    if (message.type === "presence") {
      this.options.handlers.onPresence(message.peers);
      return;
    }

    if (message.type === "joined") {
      await this.options.handlers.onJoined({
        roomId: message.roomId,
        clientId: message.clientId,
        peers: message.peers,
        existingPeerIds: message.peers
          .map((peer) => peer.clientId)
          .filter((clientId) => clientId !== this.options.clientId),
        opLog: message.opLog
      });
      return;
    }

    await this.options.handlers.onOperation({
      op: message.op,
      sourceClientId: message.clientId
    });
  }

  private sendRaw(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.socket.send(JSON.stringify(message));
    return true;
  }
}
