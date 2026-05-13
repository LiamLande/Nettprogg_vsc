import { CrdtOperation } from "./types";

export function serializeOperation(operation: CrdtOperation): string {
  return JSON.stringify(operation);
}

export function parseOperation(input: string): CrdtOperation {
  const parsed = JSON.parse(input) as unknown;

  if (!isOperation(parsed)) {
    throw new Error("Invalid CRDT operation payload.");
  }

  return parsed;
}

export function isOperation(value: unknown): value is CrdtOperation {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CrdtOperation>;
  if (candidate.type === "insert") {
    return Boolean(candidate.opId && "parentId" in candidate && typeof candidate.value === "string");
  }

  if (candidate.type === "delete") {
    return Boolean(candidate.opId && "targetId" in candidate);
  }

  return false;
}
