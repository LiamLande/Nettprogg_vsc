export type ReplicaId = string;

export type RootId = "ROOT";

export type ElementId = {
  counter: number;
  replicaId: ReplicaId;
};

export type ParentId = ElementId | RootId;

export type CharElement = {
  id: ElementId;
  value: string;
  parentId: ParentId;
  deleted: boolean;
};

export type InsertOp = {
  type: "insert";
  opId: ElementId;
  parentId: ParentId;
  value: string;
};

export type DeleteOp = {
  type: "delete";
  opId: ElementId;
  targetId: ElementId;
};

export type CrdtOperation = InsertOp | DeleteOp;

export type ApplyResult =
  | {
      status: "applied";
      opId: string;
      drained: number;
    }
  | {
      status: "duplicate";
      opId: string;
      drained: 0;
    }
  | {
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
