import { CrdtOperation } from "./types";

/** Serialises an operation to a JSON string for transmission. */
export function serializeOperation(operation: CrdtOperation): string {
  return JSON.stringify(operation);
}

/**
 * Parses a JSON string into a {@link CrdtOperation}.
 * @throws if the payload does not match the expected shape.
 */
export function parseOperation(input: string): CrdtOperation {
  const parsed = JSON.parse(input) as unknown;

  if (!isOperation(parsed)) {
    throw new Error("Invalid CRDT operation payload.");
  }

  return parsed;
}

/** Type guard — returns `true` when `value` is a valid {@link CrdtOperation}. */
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
