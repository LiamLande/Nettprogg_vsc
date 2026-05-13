import { TextCrdtSnapshot } from "../crdt/textCrdt";
import { CrdtOperation } from "../crdt/types";
import { PeerInfo } from "../shared/messages";

export type TransportMode = "relay" | "p2p";

export type TransportJoinedEvent = {
  roomId: string;
  clientId: string;
  peers: PeerInfo[];
  existingPeerIds: string[];
  opLog?: CrdtOperation[];
};

export type TransportOperationEvent = {
  op: CrdtOperation;
  sourceClientId?: string;
};

export type TransportSnapshotEvent = {
  snapshot: TextCrdtSnapshot;
  sourceClientId?: string;
};

export type TransportHandlers = {
  onJoined(event: TransportJoinedEvent): void | Promise<void>;
  onPresence(peers: PeerInfo[]): void;
  onOperation(event: TransportOperationEvent): void | Promise<void>;
  onSnapshotRequest?(clientId: string): void | Promise<void>;
  onSnapshot?(event: TransportSnapshotEvent): void | Promise<void>;
  onPeerChannelOpen?(clientId: string): void;
  onClose?(): void;
  onError?(message: string): void;
  log?(message: string): void;
};

export interface CollaborationTransport {
  connect(): void;
  close(): void;
  sendOperation(operation: CrdtOperation, exceptClientId?: string): boolean;
  requestSnapshot?(clientId?: string): boolean;
  sendSnapshot?(clientId: string, snapshot: TextCrdtSnapshot): boolean;
  connectedPeerIds?(): string[];
}
