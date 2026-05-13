import { CrdtOperation } from "../crdt/types";

export type PeerInfo = {
  clientId: string;
  connectedAt: number;
};

export type JoinMessage = {
  type: "join";
  roomId: string;
  clientId: string;
};

export type OperationMessage = {
  type: "operation";
  roomId: string;
  clientId: string;
  op: CrdtOperation;
};

export type ClientMessage = JoinMessage | OperationMessage;

export type JoinedMessage = {
  type: "joined";
  roomId: string;
  clientId: string;
  peers: PeerInfo[];
  opLog: CrdtOperation[];
};

export type PresenceMessage = {
  type: "presence";
  roomId: string;
  peers: PeerInfo[];
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

export type ServerMessage = JoinedMessage | OperationMessage | PresenceMessage | ErrorMessage;

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ClientMessage>;
  if (candidate.type === "join") {
    return typeof candidate.roomId === "string" && typeof candidate.clientId === "string";
  }

  if (candidate.type === "operation") {
    return typeof candidate.roomId === "string" && typeof candidate.clientId === "string" && Boolean(candidate.op);
  }

  return false;
}
