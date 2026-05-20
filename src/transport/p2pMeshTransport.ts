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
import { isP2PDataMessage, type P2PDataMessage, type P2PSnapshotChunkMessage } from "./p2pDataMessages";
import { CollaborationTransport, TransportHandlers } from "./types";

const SNAPSHOT_CHUNK_SIZE = 16 * 1024;
const SNAPSHOT_CHUNK_TTL_MS = 60_000;
const DATA_CHANNEL_BUFFER_LOW_THRESHOLD = SNAPSHOT_CHUNK_SIZE * 4;
const DATA_CHANNEL_BUFFER_HIGH_WATERMARK = SNAPSHOT_CHUNK_SIZE * 16;
const QUEUE_FLUSH_DELAY_MS = 10;

/**
 * Detects messages that only the relay server emits. Used to give a clear
 * error if the user accidentally points the P2P transport at the relay URL.
 * The relay's `joined` payload always carries `opLog`; the signaling server
 * never includes that field.
 */
function isLikelyRelayServerMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: unknown; opLog?: unknown };
  return candidate.type === "joined" && Array.isArray(candidate.opLog);
}

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
  flushTimer?: NodeJS.Timeout;
  queuedMessages: P2PDataMessage[];
  pendingCandidates: RemoteCandidate[];
};

type SnapshotChunkBuffer = {
  chunks: Array<string | undefined>;
  createdAt: number;
  received: number;
  total: number;
};

type SendAttemptResult = "sent" | "retry" | "failed";

export class P2PMeshTransport implements CollaborationTransport {
  private signalingSocket?: WebSocket;
  private disposed = false;
  private readonly roomPeers = new Map<string, SignalingPeerInfo>();
  private readonly meshPeers = new Map<string, MeshPeer>();
  private readonly snapshotChunks = new Map<string, SnapshotChunkBuffer>();

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
        if (isLikelyRelayServerMessage(parsed)) {
          this.options.handlers.onError?.(
            "P2P mode is connected to a relay server endpoint. Start the signaling server and use its URL (default ws://127.0.0.1:7072)."
          );
          socket.close();
          return;
        }

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
      this.clearPeerFlushTimer(peer);
      peer.dataChannel?.close();
      peer.peerConnection.close();
    }

    this.meshPeers.clear();
    this.roomPeers.clear();
    this.snapshotChunks.clear();
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
    const snapshotJson = JSON.stringify(snapshot);
    if (Buffer.byteLength(snapshotJson, "utf8") <= SNAPSHOT_CHUNK_SIZE) {
      return this.sendDataMessage(clientId, {
        type: "snapshot",
        clientId: this.options.clientId,
        snapshot
      });
    }

    const encoded = Buffer.from(snapshotJson, "utf8").toString("base64");
    const snapshotId = `${this.options.clientId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const total = Math.ceil(encoded.length / SNAPSHOT_CHUNK_SIZE);
    this.options.handlers.log?.(`Sending P2P snapshot to ${clientId} in ${total} chunks.`);

    let sent = true;
    for (let index = 0; index < total; index += 1) {
      sent =
        this.sendDataMessage(clientId, {
          type: "snapshot-chunk",
          clientId: this.options.clientId,
          snapshotId,
          index,
          total,
          chunk: encoded.slice(index * SNAPSHOT_CHUNK_SIZE, (index + 1) * SNAPSHOT_CHUNK_SIZE)
        }) && sent;
    }

    if (!sent) {
      this.options.handlers.onError?.(`Failed to send complete P2P snapshot to ${clientId}.`);
    }

    return sent;
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

    this.clearPeerFlushTimer(peer);
    peer.dataChannel?.close();
    peer.peerConnection.close();
    this.meshPeers.delete(clientId);
  }

  private attachDataChannel(peer: MeshPeer, channel: DataChannel): void {
    peer.dataChannel = channel;
    channel.setBufferedAmountLowThreshold(DATA_CHANNEL_BUFFER_LOW_THRESHOLD);

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
      this.clearPeerFlushTimer(peer);
    });
    channel.onError((error) => {
      this.options.handlers.onError?.(`P2P peer ${peer.clientId}: ${error}`);
    });
    channel.onBufferedAmountLow(() => {
      this.flushPeerQueue(peer);
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

    if (parsed.type === "snapshot-chunk") {
      await this.handleSnapshotChunk(peerId, parsed);
      return;
    }

    await this.options.handlers.onSnapshot?.({
      snapshot: parsed.snapshot,
      sourceClientId: peerId
    });
  }

  private async handleSnapshotChunk(peerId: string, message: P2PSnapshotChunkMessage): Promise<void> {
    this.cleanupSnapshotChunks();

    const key = `${peerId}:${message.snapshotId}`;
    let buffer = this.snapshotChunks.get(key);
    if (!buffer || buffer.total !== message.total) {
      buffer = {
        chunks: new Array<string | undefined>(message.total),
        createdAt: Date.now(),
        received: 0,
        total: message.total
      };
      this.snapshotChunks.set(key, buffer);
    }

    if (buffer.chunks[message.index] === undefined) {
      buffer.received += 1;
    }
    buffer.chunks[message.index] = message.chunk;

    if (buffer.received < buffer.total) {
      return;
    }

    this.snapshotChunks.delete(key);

    try {
      const encoded = buffer.chunks.join("");
      const snapshot = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as TextCrdtSnapshot;
      await this.options.handlers.onSnapshot?.({
        snapshot,
        sourceClientId: peerId
      });
    } catch (error) {
      this.options.handlers.onError?.(
        error instanceof Error ? error.message : `Failed to decode P2P snapshot from ${peerId}.`
      );
    }
  }

  private cleanupSnapshotChunks(): void {
    const cutoff = Date.now() - SNAPSHOT_CHUNK_TTL_MS;
    for (const [key, buffer] of this.snapshotChunks) {
      if (buffer.createdAt < cutoff) {
        this.snapshotChunks.delete(key);
      }
    }
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

    if (peer.queuedMessages.length > 0) {
      peer.queuedMessages.push(message);
      this.flushPeerQueue(peer);
      return true;
    }

    const result = this.trySendDataMessage(peer, message);
    if (result === "sent") {
      return true;
    }

    if (result === "retry") {
      peer.queuedMessages.push(message);
      this.schedulePeerQueueFlush(peer);
      return true;
    }

    return false;
  }

  private flushPeerQueue(peer: MeshPeer): void {
    this.clearPeerFlushTimer(peer);
    if (!peer.channelOpen || !peer.dataChannel?.isOpen()) {
      return;
    }

    while (peer.queuedMessages.length > 0) {
      const message = peer.queuedMessages.shift();
      if (!message) {
        return;
      }

      const result = this.trySendDataMessage(peer, message);
      if (result === "retry") {
        peer.queuedMessages.unshift(message);
        this.schedulePeerQueueFlush(peer);
        return;
      }

      if (result === "failed") {
        continue;
      }

      if ((peer.dataChannel?.bufferedAmount() ?? 0) >= DATA_CHANNEL_BUFFER_HIGH_WATERMARK) {
        this.schedulePeerQueueFlush(peer);
        return;
      }
    }
  }

  private trySendDataMessage(peer: MeshPeer, message: P2PDataMessage): SendAttemptResult {
    if (!peer.channelOpen || !peer.dataChannel?.isOpen()) {
      return "retry";
    }

    const payload = JSON.stringify(message);
    const maxMessageSize = peer.dataChannel.maxMessageSize();
    if (maxMessageSize > 0 && Buffer.byteLength(payload, "utf8") > maxMessageSize) {
      this.options.handlers.onError?.(
        `P2P ${message.type} message for ${peer.clientId} is larger than the data channel limit.`
      );
      return "failed";
    }

    return peer.dataChannel.sendMessage(payload) ? "sent" : "retry";
  }

  private schedulePeerQueueFlush(peer: MeshPeer): void {
    if (peer.flushTimer) {
      return;
    }

    peer.flushTimer = setTimeout(() => {
      peer.flushTimer = undefined;
      this.flushPeerQueue(peer);
    }, QUEUE_FLUSH_DELAY_MS);
  }

  private clearPeerFlushTimer(peer: MeshPeer): void {
    if (!peer.flushTimer) {
      return;
    }

    clearTimeout(peer.flushTimer);
    peer.flushTimer = undefined;
  }

  private rtcConfig(): RtcConfig {
    return {
      iceServers: this.options.iceServers
    };
  }
}
