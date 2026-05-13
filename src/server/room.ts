import WebSocket from "ws";
import { OperationLog } from "../crdt/operationLog";
import { CrdtOperation } from "../crdt/types";
import { OperationMessage, PeerInfo, PresenceMessage, ServerMessage } from "../shared/messages";

type Peer = {
  clientId: string;
  connectedAt: number;
  socket: WebSocket;
};

export class Room {
  private readonly peers = new Map<string, Peer>();
  private readonly opLog = new OperationLog();

  constructor(readonly roomId: string) {}

  addPeer(clientId: string, socket: WebSocket): void {
    const previous = this.peers.get(clientId);
    if (previous && previous.socket !== socket) {
      previous.socket.close();
    }

    this.peers.set(clientId, {
      clientId,
      connectedAt: Date.now(),
      socket
    });

    this.broadcastPresence();
  }

  removePeer(clientId: string, socket: WebSocket): void {
    const current = this.peers.get(clientId);
    if (current?.socket === socket) {
      this.peers.delete(clientId);
      this.broadcastPresence();
    }
  }

  appendOperation(operation: CrdtOperation): boolean {
    return this.opLog.append(operation);
  }

  operations(): CrdtOperation[] {
    return this.opLog.all();
  }

  peerList(): PeerInfo[] {
    return Array.from(this.peers.values())
      .map((peer) => ({
        clientId: peer.clientId,
        connectedAt: peer.connectedAt
      }))
      .sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  broadcastOperation(message: OperationMessage): void {
    this.broadcast(message);
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  private broadcastPresence(): void {
    const message: PresenceMessage = {
      type: "presence",
      roomId: this.roomId,
      peers: this.peerList()
    };
    this.broadcast(message);
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      if (peer.socket.readyState === WebSocket.OPEN) {
        peer.socket.send(payload);
      }
    }
  }
}
