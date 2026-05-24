import { TextCrdtSnapshot } from "../crdt/textCrdt";
import { CrdtOperation } from "../crdt/types";
import { PeerInfo } from "../shared/messages";

export type TransportMode = "relay" | "p2p";

/** Emitted when this client successfully joins a room. */
export type TransportJoinedEvent = {
  roomId: string;
  clientId: string;
  peers: PeerInfo[];
  /** Peers already in the room when we joined (excludes ourselves). */
  existingPeerIds: string[];
  /** Full operation log replayed by the relay server on join (relay mode only). */
  opLog?: CrdtOperation[];
};

/** Emitted when a remote operation arrives from another peer. */
export type TransportOperationEvent = {
  op: CrdtOperation;
  sourceClientId?: string;
};

/** Emitted when a peer sends us their full CRDT snapshot (P2P mode only). */
export type TransportSnapshotEvent = {
  snapshot: TextCrdtSnapshot;
  sourceClientId?: string;
};

/** Callbacks wired up by {@link SessionManager} to a {@link CollaborationTransport}. */
export type TransportHandlers = {
  onJoined(event: TransportJoinedEvent): void | Promise<void>;
  onPresence(peers: PeerInfo[]): void;
  onOperation(event: TransportOperationEvent): void | Promise<void>;
  /** Called when a peer requests our current CRDT snapshot (P2P only). */
  onSnapshotRequest?(clientId: string): void | Promise<void>;
  /** Called when we receive a CRDT snapshot from a peer (P2P only). */
  onSnapshot?(event: TransportSnapshotEvent): void | Promise<void>;
  /** Called when a WebRTC data channel to a peer opens (P2P only). */
  onPeerChannelOpen?(clientId: string): void;
  onClose?(): void;
  onError?(message: string): void;
  log?(message: string): void;
};

/** Abstraction over relay-server and WebRTC mesh transports. */
export interface CollaborationTransport {
  connect(): void;
  close(): void;
  /** Sends `operation` to all peers. Returns `false` if not connected. */
  sendOperation(operation: CrdtOperation, exceptClientId?: string): boolean;
  /** Requests a full CRDT snapshot from `clientId` (P2P only). */
  requestSnapshot?(clientId?: string): boolean;
  /** Sends our snapshot to `clientId` (P2P only). */
  sendSnapshot?(clientId: string, snapshot: TextCrdtSnapshot): boolean;
  connectedPeerIds?(): string[];
}
