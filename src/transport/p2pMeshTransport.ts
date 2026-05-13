import dataChannel from "node-datachannel";
import type { DataChannel, PeerConnection, RtcConfig } from "node-datachannel";
import WebSocket from "ws";
import { TextCrdtSnapshot } from "../crdt/textCrdt";
import { CrdtOperation } from "../crdt/types";
import {
  SignalingPeerInfo,
  SignalingServerMessage,
  SignalingSignalPayload,
  isSignalingServerMessage
} from "../shared/signalingMessages";
import { isP2PDataMessage, P2PDataMessage } from "./p2pDataMessages";
import { CollaborationTransport, TransportHandlers } from "./types";

export type P2PMeshTransportOptions = {
  signalingUrl: string;
  roomId: string;
  clientId: string;
  iceServers: string[];
  handlers: TransportHandlers;
};

type RemoteCandidate = {
  candidate: string;
  mid: string;
};

type MeshPeer = {
  clientId: string;
  connectedAt: number;
  peerConnection: PeerConnection;
  dataChannel?: DataChannel;
  channelOpen: boolean;
  queuedMessages: P2PDataMessage[];
  pendingCandidates: RemoteCandidate[];
};

export class P2PMeshTransport implements CollaborationTransport {
  private signalingSocket?: WebSocket;
  private disposed = false;
  private readonly roomPeers = new Map<string, SignalingPeerInfo>();
  private readonly meshPeers = new Map<string, MeshPeer>();

  constructor(private readonly options: P2PMeshTransportOptions) {}

  connect(): void {
    this.disposed = false;
    const socket = new WebSocket(this.options.signalingUrl);
    this.signalingSocket = socket;

    socket.on("open", () => {
      this.sendSignaling({
        type: "join",
        roomId: this.options.roomId,
        clientId: this.options.clientId
      });
    });

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!isSignalingServerMessage(parsed)) {
          this.options.handlers.onError?.("Invalid signaling message.");
          return;
        }

        void this.handleSignalingMessage(parsed);
      } catch (error) {
        this.options.handlers.onError?.(error instanceof Error ? error.message : "Invalid signaling message.");
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
    this.signalingSocket?.close();
    this.signalingSocket = undefined;

    for (const peer of this.meshPeers.values()) {
      peer.dataChannel?.close();
      peer.peerConnection.close();
    }

    this.meshPeers.clear();
    this.roomPeers.clear();
  }

  sendOperation(operation: CrdtOperation, exceptClientId?: string): boolean {
    return this.broadcastDataMessage(
      {
        type: "operation",
        clientId: this.options.clientId,
        op: operation
      },
      exceptClientId
    );
  }

  requestSnapshot(clientId?: string): boolean {
    const message: P2PDataMessage = {
      type: "snapshot-request",
      clientId: this.options.clientId
    };

    if (clientId) {
      return this.sendDataMessage(clientId, message);
    }

    for (const peerId of this.connectedPeerIds()) {
      return this.sendDataMessage(peerId, message);
    }

    return false;
  }

  sendSnapshot(clientId: string, snapshot: TextCrdtSnapshot): boolean {
    return this.sendDataMessage(clientId, {
      type: "snapshot",
      clientId: this.options.clientId,
      snapshot
    });
  }

  connectedPeerIds(): string[] {
    return Array.from(this.meshPeers.values())
      .filter((peer) => peer.channelOpen)
      .map((peer) => peer.clientId)
      .sort((a, b) => a.localeCompare(b));
  }

  private async handleSignalingMessage(message: SignalingServerMessage): Promise<void> {
    if (message.type === "error") {
      this.options.handlers.onError?.(message.message);
      return;
    }

    if (message.type === "joined") {
      this.replaceRoomPeers(message.peers);
      const existingPeerIds = message.peers
        .map((peer) => peer.clientId)
        .filter((clientId) => clientId !== this.options.clientId)
        .sort((a, b) => a.localeCompare(b));

      for (const clientId of existingPeerIds) {
        const peer = this.roomPeers.get(clientId);
        if (peer) {
          this.ensureMeshPeer(peer);
        }
      }

      await this.options.handlers.onJoined({
        roomId: message.roomId,
        clientId: message.clientId,
        peers: message.peers,
        existingPeerIds
      });
      this.options.handlers.onPresence(message.peers);
      return;
    }

    if (message.type === "peerJoined") {
      this.replaceRoomPeers(message.peers);
      this.ensureMeshPeer(message.peer);
      this.options.handlers.onPresence(message.peers);
      return;
    }

    if (message.type === "peerLeft") {
      this.replaceRoomPeers(message.peers);
      this.closeMeshPeer(message.clientId);
      this.options.handlers.onPresence(message.peers);
      return;
    }

    const peerInfo = this.roomPeers.get(message.clientId) ?? {
      clientId: message.clientId,
      connectedAt: Date.now()
    };
    this.roomPeers.set(message.clientId, peerInfo);
    const peer = this.ensureMeshPeer(peerInfo);
    this.applySignal(peer, message.signal);
  }

  private replaceRoomPeers(peers: SignalingPeerInfo[]): void {
    this.roomPeers.clear();
    for (const peer of peers) {
      this.roomPeers.set(peer.clientId, peer);
    }
  }

  private ensureMeshPeer(peerInfo: SignalingPeerInfo): MeshPeer {
    const existing = this.meshPeers.get(peerInfo.clientId);
    if (existing) {
      return existing;
    }

    const peerConnection = new dataChannel.PeerConnection(peerInfo.clientId, this.rtcConfig());
    const peer: MeshPeer = {
      clientId: peerInfo.clientId,
      connectedAt: peerInfo.connectedAt,
      peerConnection,
      channelOpen: false,
      queuedMessages: [],
      pendingCandidates: []
    };
    this.meshPeers.set(peerInfo.clientId, peer);

    peerConnection.onLocalDescription((sdp, type) => {
      this.sendSignal(peer.clientId, {
        type: "description",
        descriptionType: type,
        sdp
      });
    });

    peerConnection.onLocalCandidate((candidate, mid) => {
      this.sendSignal(peer.clientId, {
        type: "candidate",
        candidate,
        mid
      });
    });

    peerConnection.onDataChannel((channel) => {
      this.attachDataChannel(peer, channel);
    });

    peerConnection.onStateChange((state) => {
      this.options.handlers.log?.(`P2P peer ${peer.clientId} state ${state}`);
      if (state === "closed" || state === "failed") {
        peer.channelOpen = false;
      }
    });

    if (this.options.clientId.localeCompare(peer.clientId) < 0) {
      this.attachDataChannel(peer, peerConnection.createDataChannel("liveshare-lite"));
    }

    return peer;
  }

  private closeMeshPeer(clientId: string): void {
    const peer = this.meshPeers.get(clientId);
    if (!peer) {
      return;
    }

    peer.dataChannel?.close();
    peer.peerConnection.close();
    this.meshPeers.delete(clientId);
  }

  private attachDataChannel(peer: MeshPeer, channel: DataChannel): void {
    peer.dataChannel = channel;

    const markOpen = () => {
      peer.channelOpen = true;
      this.sendDataMessage(peer.clientId, {
        type: "hello",
        clientId: this.options.clientId
      });
      this.flushPeerQueue(peer);
      this.options.handlers.onPeerChannelOpen?.(peer.clientId);
    };

    channel.onOpen(markOpen);
    channel.onClosed(() => {
      peer.channelOpen = false;
    });
    channel.onError((error) => {
      this.options.handlers.onError?.(`P2P peer ${peer.clientId}: ${error}`);
    });
    channel.onMessage((raw) => {
      void this.handleDataMessage(peer.clientId, raw);
    });

    if (channel.isOpen()) {
      markOpen();
    }
  }

  private async handleDataMessage(peerId: string, raw: string | Buffer | ArrayBuffer): Promise<void> {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      this.options.handlers.onError?.(error instanceof Error ? error.message : `Invalid P2P data message from ${peerId}.`);
      return;
    }

    if (!isP2PDataMessage(parsed)) {
      this.options.handlers.onError?.(`Invalid P2P data message from ${peerId}.`);
      return;
    }

    if (parsed.type === "hello") {
      if (parsed.clientId !== peerId) {
        this.options.handlers.onError?.(`P2P identity mismatch: expected ${peerId}, got ${parsed.clientId}.`);
      }
      return;
    }

    if (parsed.type === "operation") {
      await this.options.handlers.onOperation({
        op: parsed.op,
        sourceClientId: peerId
      });
      return;
    }

    if (parsed.type === "snapshot-request") {
      await this.options.handlers.onSnapshotRequest?.(peerId);
      return;
    }

    await this.options.handlers.onSnapshot?.({
      snapshot: parsed.snapshot,
      sourceClientId: peerId
    });
  }

  private applySignal(peer: MeshPeer, signal: SignalingSignalPayload): void {
    try {
      if (signal.type === "description") {
        peer.peerConnection.setRemoteDescription(signal.sdp, signal.descriptionType);
        this.flushRemoteCandidates(peer);
        return;
      }

      if (peer.peerConnection.remoteDescription()) {
        peer.peerConnection.addRemoteCandidate(signal.candidate, signal.mid);
      } else {
        peer.pendingCandidates.push({
          candidate: signal.candidate,
          mid: signal.mid
        });
      }
    } catch (error) {
      this.options.handlers.onError?.(error instanceof Error ? error.message : "Failed to apply P2P signal.");
    }
  }

  private flushRemoteCandidates(peer: MeshPeer): void {
    const candidates = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of candidates) {
      peer.peerConnection.addRemoteCandidate(candidate.candidate, candidate.mid);
    }
  }

  private sendSignal(targetClientId: string, signal: SignalingSignalPayload): boolean {
    return this.sendSignaling({
      type: "signal",
      roomId: this.options.roomId,
      clientId: this.options.clientId,
      targetClientId,
      signal
    });
  }

  private sendSignaling(message: object): boolean {
    if (this.signalingSocket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.signalingSocket.send(JSON.stringify(message));
    return true;
  }

  private broadcastDataMessage(message: P2PDataMessage, exceptClientId?: string): boolean {
    let sent = false;
    for (const peerId of Array.from(this.meshPeers.keys()).sort((a, b) => a.localeCompare(b))) {
      if (peerId !== exceptClientId) {
        sent = this.sendDataMessage(peerId, message) || sent;
      }
    }
    return sent;
  }

  private sendDataMessage(clientId: string, message: P2PDataMessage): boolean {
    const peer = this.meshPeers.get(clientId);
    if (!peer) {
      return false;
    }

    if (!peer.channelOpen || !peer.dataChannel?.isOpen()) {
      peer.queuedMessages.push(message);
      return true;
    }

    return peer.dataChannel.sendMessage(JSON.stringify(message));
  }

  private flushPeerQueue(peer: MeshPeer): void {
    const queued = peer.queuedMessages;
    peer.queuedMessages = [];
    for (const message of queued) {
      this.sendDataMessage(peer.clientId, message);
    }
  }

  private rtcConfig(): RtcConfig {
    return {
      iceServers: this.options.iceServers
    };
  }
}
