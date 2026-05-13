import { TextCrdtSnapshot } from "../crdt/textCrdt";
import { CrdtOperation } from "../crdt/types";

export type P2PHelloMessage = {
  type: "hello";
  clientId: string;
};

export type P2POperationMessage = {
  type: "operation";
  clientId: string;
  op: CrdtOperation;
};

export type P2PSnapshotRequestMessage = {
  type: "snapshot-request";
  clientId: string;
};

export type P2PSnapshotMessage = {
  type: "snapshot";
  clientId: string;
  snapshot: TextCrdtSnapshot;
};

export type P2PDataMessage = P2PHelloMessage | P2POperationMessage | P2PSnapshotRequestMessage | P2PSnapshotMessage;

export function isP2PDataMessage(value: unknown): value is P2PDataMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<P2PDataMessage>;
  if (candidate.type === "hello" || candidate.type === "snapshot-request") {
    return typeof candidate.clientId === "string";
  }

  if (candidate.type === "operation") {
    return typeof candidate.clientId === "string" && Boolean(candidate.op);
  }

  if (candidate.type === "snapshot") {
    return typeof candidate.clientId === "string" && Boolean(candidate.snapshot);
  }

  return false;
}
