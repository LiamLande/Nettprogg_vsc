import { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { Room } from "./room";
import { ClientMessage, JoinedMessage, ServerMessage, isClientMessage } from "../shared/messages";

export type RelayServerOptions = {
  port?: number;
  host?: string;
};

type ConnectionState = {
  roomId?: string;
  clientId?: string;
};

export class RelayServer {
  private server?: WebSocketServer;
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly options: RelayServerOptions = {}) {}

  async start(): Promise<number> {
    if (this.server) {
      return this.port();
    }

    this.server = new WebSocketServer({
      port: this.options.port ?? 7071,
      host: this.options.host ?? "127.0.0.1"
    });

    this.server.on("connection", (socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server?.once("listening", () => resolve());
      this.server?.once("error", reject);
    });

    return this.port();
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    for (const client of server.clients) {
      client.close();
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = undefined;
    this.rooms.clear();
  }

  port(): number {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      return this.options.port ?? 7071;
    }

    return (address as AddressInfo).port;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  private handleConnection(socket: WebSocket): void {
    const state: ConnectionState = {};

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!isClientMessage(parsed)) {
          this.send(socket, { type: "error", message: "Invalid message." });
          return;
        }

        this.handleMessage(socket, state, parsed);
      } catch (error) {
        this.send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown relay error."
        });
      }
    });

    socket.on("close", () => {
      if (state.roomId && state.clientId) {
        const room = this.rooms.get(state.roomId);
        room?.removePeer(state.clientId, socket);
      }
    });
  }

  private handleMessage(socket: WebSocket, state: ConnectionState, message: ClientMessage): void {
    if (message.type === "join") {
      const room = this.getRoom(message.roomId);
      state.roomId = message.roomId;
      state.clientId = message.clientId;
      room.addPeer(message.clientId, socket);

      const joined: JoinedMessage = {
        type: "joined",
        roomId: message.roomId,
        clientId: message.clientId,
        peers: room.peerList(),
        opLog: room.operations()
      };
      this.send(socket, joined);
      return;
    }

    const room = this.rooms.get(message.roomId);
    if (!room || state.roomId !== message.roomId || state.clientId !== message.clientId) {
      this.send(socket, { type: "error", message: "Client must join the room before sending operations." });
      return;
    }

    room.appendOperation(message.op);
    room.broadcastOperation(message);
  }

  private getRoom(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const created = new Room(roomId);
    this.rooms.set(roomId, created);
    return created;
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
