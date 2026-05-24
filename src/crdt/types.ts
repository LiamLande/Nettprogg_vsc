export type ReplicaId = string;

export type RootId = "ROOT";

/** Globally unique identifier for a CRDT element: `(counter, replicaId)`. */
export type ElementId = {
  counter: number;
  replicaId: ReplicaId;
};

/**
 * Insertion anchor — either the document root or the element immediately to
 * the left of the new character.
 */
export type ParentId = ElementId | RootId;

/** A single character node in the CRDT tree. */
export type CharElement = {
  id: ElementId;
  value: string;
  parentId: ParentId;
  /** `true` once this element has been logically deleted (tombstone). */
  deleted: boolean;
};

/** Inserts a single character to the right of `parentId`. */
export type InsertOp = {
  type: "insert";
  opId: ElementId;
  parentId: ParentId;
  value: string;
};

/** Tombstones the element identified by `targetId`. */
export type DeleteOp = {
  type: "delete";
  opId: ElementId;
  targetId: ElementId;
};

export type CrdtOperation = InsertOp | DeleteOp;

/** Result returned by {@link TextCrdt.applyOperation}. */
export type ApplyResult =
  | {
      /** The operation was applied; `drained` pending operations also became ready. */
      status: "applied";
      opId: string;
      drained: number;
    }
  | {
      /** The operation was already known; no state changed. */
      status: "duplicate";
      opId: string;
      drained: 0;
    }
  | {
      /** The operation's dependency is missing; it was buffered for later. */
      status: "queued";
      opId: string;
      drained: 0;
    };

export function isRootId(id: ParentId): id is RootId {
  return id === "ROOT";
}

export function elementId(counter: number, replicaId: ReplicaId): ElementId {
  return { counter, replicaId };
}

export function idKey(id: ParentId): string {
  return isRootId(id) ? id : `${id.replicaId}:${id.counter}`;
}

export function compareElementId(left: ElementId, right: ElementId): number {
  if (left.counter !== right.counter) {
    return left.counter - right.counter;
  }

  return left.replicaId.localeCompare(right.replicaId);
}

export function compareElementIdDescending(left: ElementId, right: ElementId): number {
  return compareElementId(right, left);
}

export function sameElementId(left: ElementId, right: ElementId): boolean {
  return left.counter === right.counter && left.replicaId === right.replicaId;
}

export function cloneElementId(id: ElementId): ElementId {
  return { counter: id.counter, replicaId: id.replicaId };
}

export function cloneParentId(id: ParentId): ParentId {
  return isRootId(id) ? "ROOT" : cloneElementId(id);
}
