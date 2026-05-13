import { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import {
  SignalingClientMessage,
  SignalingJoinedMessage,
  SignalingPeerInfo,
  SignalingPeerJoinedMessage,
  SignalingPeerLeftMessage,
  SignalingServerMessage,
  isSignalingClientMessage
} from "../shared/signalingMessages";

export type SignalingServerOptions = {
  port?: number;
  host?: string;
};

type SignalingConnectionState = {
  roomId?: string;
  clientId?: string;
};

type SignalingPeer = {
  clientId: string;
  connectedAt: number;
  socket: WebSocket;
};

class SignalingRoom {
  private readonly peers = new Map<string, SignalingPeer>();

  constructor(readonly roomId: string) {}

  addPeer(clientId: string, socket: WebSocket): SignalingPeer {
    const previous = this.peers.get(clientId);
    if (previous && previous.socket !== socket) {
      previous.socket.close();
    }

    const peer = {
      clientId,
      connectedAt: Date.now(),
      socket
    };
    this.peers.set(clientId, peer);
    return peer;
  }

  removePeer(clientId: string, socket: WebSocket): boolean {
    const current = this.peers.get(clientId);
    if (current?.socket !== socket) {
      return false;
    }

    this.peers.delete(clientId);
    return true;
  }

  getPeer(clientId: string): SignalingPeer | undefined {
    return this.peers.get(clientId);
  }

  peerList(): SignalingPeerInfo[] {
    return Array.from(this.peers.values())
      .map((peer) => ({
        clientId: peer.clientId,
        connectedAt: peer.connectedAt
      }))
      .sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  broadcast(message: SignalingServerMessage, exceptClientId?: string): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      if (peer.clientId !== exceptClientId && peer.socket.readyState === WebSocket.OPEN) {
        peer.socket.send(payload);
      }
    }
  }
}

export class SignalingServer {
  private server?: WebSocketServer;
  private readonly rooms = new Map<string, SignalingRoom>();

  constructor(private readonly options: SignalingServerOptions = {}) {}

  async start(): Promise<number> {
    if (this.server) {
      return this.port();
    }

    this.server = new WebSocketServer({
      port: this.options.port ?? 7072,
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
      return this.options.port ?? 7072;
    }

    return (address as AddressInfo).port;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  private handleConnection(socket: WebSocket): void {
    const state: SignalingConnectionState = {};

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!isSignalingClientMessage(parsed)) {
          this.send(socket, { type: "error", message: "Invalid signaling message." });
          return;
        }

        this.handleMessage(socket, state, parsed);
      } catch (error) {
        this.send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown signaling error."
        });
      }
    });

    socket.on("close", () => {
      if (!state.roomId || !state.clientId) {
        return;
      }

      const room = this.rooms.get(state.roomId);
      if (!room?.removePeer(state.clientId, socket)) {
        return;
      }

      const message: SignalingPeerLeftMessage = {
        type: "peerLeft",
        roomId: state.roomId,
        clientId: state.clientId,
        peers: room.peerList()
      };
      room.broadcast(message);

      if (room.isEmpty()) {
        this.rooms.delete(state.roomId);
      }
    });
  }

  private handleMessage(socket: WebSocket, state: SignalingConnectionState, message: SignalingClientMessage): void {
    if (message.type === "join") {
      const room = this.getRoom(message.roomId);
      const peer = room.addPeer(message.clientId, socket);
      state.roomId = message.roomId;
      state.clientId = message.clientId;

      const joined: SignalingJoinedMessage = {
        type: "joined",
        roomId: message.roomId,
        clientId: message.clientId,
        peers: room.peerList()
      };
      this.send(socket, joined);

      const peerJoined: SignalingPeerJoinedMessage = {
        type: "peerJoined",
        roomId: message.roomId,
        peer: {
          clientId: peer.clientId,
          connectedAt: peer.connectedAt
        },
        peers: room.peerList()
      };
      room.broadcast(peerJoined, message.clientId);
      return;
    }

    const room = this.rooms.get(message.roomId);
    if (!room || state.roomId !== message.roomId || state.clientId !== message.clientId) {
      this.send(socket, { type: "error", message: "Client must join the room before signaling." });
      return;
    }

    const target = room.getPeer(message.targetClientId);
    if (!target || target.socket.readyState !== WebSocket.OPEN) {
      this.send(socket, { type: "error", message: `Target peer ${message.targetClientId} is not connected.` });
      return;
    }

    this.send(target.socket, message);
  }

  private getRoom(roomId: string): SignalingRoom {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const created = new SignalingRoom(roomId);
    this.rooms.set(roomId, created);
    return created;
  }

  private send(socket: WebSocket, message: SignalingServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
