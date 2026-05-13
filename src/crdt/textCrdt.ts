import {
  ApplyResult,
  CharElement,
  CrdtOperation,
  DeleteOp,
  ElementId,
  InsertOp,
  ParentId,
  ReplicaId,
  cloneElementId,
  cloneParentId,
  compareElementIdDescending,
  idKey
} from "./types";

export type TextCrdtSnapshot = {
  replicaId: ReplicaId;
  counter: number;
  elements: CharElement[];
  seenOpIds: string[];
  pendingInserts: InsertOp[];
  pendingDeletes: DeleteOp[];
};

export class TextCrdt {
  private counter = 0;
  private readonly elements = new Map<string, CharElement>();
  private readonly children = new Map<string, ElementId[]>();
  private readonly seenOpIds = new Set<string>();
  private readonly pendingInserts = new Map<string, InsertOp>();
  private readonly pendingDeletes = new Map<string, DeleteOp>();

  constructor(private readonly replicaId: ReplicaId) {
    this.children.set("ROOT", []);
  }

  static fromSnapshot(snapshot: TextCrdtSnapshot, replicaId = snapshot.replicaId): TextCrdt {
    const crdt = new TextCrdt(replicaId);
    crdt.counter = maxCounterForReplica(snapshot, replicaId);

    for (const element of snapshot.elements) {
      crdt.elements.set(idKey(element.id), {
        id: cloneElementId(element.id),
        value: element.value,
        parentId: cloneParentId(element.parentId),
        deleted: element.deleted
      });
    }

    crdt.rebuildChildren();

    for (const opId of snapshot.seenOpIds) {
      crdt.seenOpIds.add(opId);
    }

    for (const op of snapshot.pendingInserts) {
      crdt.pendingInserts.set(idKey(op.opId), {
        type: "insert",
        opId: cloneElementId(op.opId),
        parentId: cloneParentId(op.parentId),
        value: op.value
      });
    }

    for (const op of snapshot.pendingDeletes) {
      crdt.pendingDeletes.set(idKey(op.opId), {
        type: "delete",
        opId: cloneElementId(op.opId),
        targetId: cloneElementId(op.targetId)
      });
    }

    return crdt;
  }

  getReplicaId(): ReplicaId {
    return this.replicaId;
  }

  nextOperationId(): ElementId {
    this.counter += 1;
    return { counter: this.counter, replicaId: this.replicaId };
  }

  insert(index: number, text: string): InsertOp[] {
    const visible = this.visibleElements();
    if (index < 0 || index > visible.length) {
      throw new RangeError(`Insert index ${index} is outside document length ${visible.length}.`);
    }

    const ops: InsertOp[] = [];
    let parentId: ParentId = index === 0 ? "ROOT" : cloneElementId(visible[index - 1].id);

    for (const value of text.split("")) {
      const op: InsertOp = {
        type: "insert",
        opId: this.nextOperationId(),
        parentId,
        value
      };
      this.applyOperation(op);
      ops.push(op);
      parentId = cloneElementId(op.opId);
    }

    return ops;
  }

  delete(index: number, count = 1): DeleteOp[] {
    const visible = this.visibleElements();
    if (count < 0) {
      throw new RangeError("Delete count cannot be negative.");
    }

    if (index < 0 || index + count > visible.length) {
      throw new RangeError(`Delete range ${index}:${count} is outside document length ${visible.length}.`);
    }

    const ops: DeleteOp[] = [];
    for (const element of visible.slice(index, index + count)) {
      const op: DeleteOp = {
        type: "delete",
        opId: this.nextOperationId(),
        targetId: cloneElementId(element.id)
      };
      this.applyOperation(op);
      ops.push(op);
    }

    return ops;
  }

  applyOperation(operation: CrdtOperation): ApplyResult {
    const opId = idKey(operation.opId);
    if (this.seenOpIds.has(opId)) {
      return { status: "duplicate", opId, drained: 0 };
    }

    this.seenOpIds.add(opId);

    if (operation.type === "insert") {
      if (!this.hasParent(operation.parentId)) {
        this.pendingInserts.set(opId, cloneInsertOp(operation));
        return { status: "queued", opId, drained: 0 };
      }

      this.applyInsert(operation);
      const drained = this.drainPending();
      return { status: "applied", opId, drained };
    }

    if (!this.elements.has(idKey(operation.targetId))) {
      this.pendingDeletes.set(opId, cloneDeleteOp(operation));
      return { status: "queued", opId, drained: 0 };
    }

    this.applyDelete(operation);
    return { status: "applied", opId, drained: 0 };
  }

  hasSeen(operation: CrdtOperation): boolean {
    return this.seenOpIds.has(idKey(operation.opId));
  }

  toString(): string {
    return this.visibleElements()
      .map((element) => element.value)
      .join("");
  }

  visibleLength(): number {
    return this.visibleElements().length;
  }

  idAtVisibleIndex(index: number): ElementId | undefined {
    return this.visibleElements()[index]?.id;
  }

  visibleElements(): CharElement[] {
    const output: CharElement[] = [];
    const stack = [...(this.children.get("ROOT") ?? [])].reverse();

    while (stack.length > 0) {
      const childId = stack.pop();
      if (!childId) {
        continue;
      }

      const child = this.elements.get(idKey(childId));
      if (!child) {
        continue;
      }

      if (!child.deleted) {
        output.push(child);
      }

      const grandchildren = this.children.get(idKey(child.id)) ?? [];
      for (let index = grandchildren.length - 1; index >= 0; index -= 1) {
        stack.push(grandchildren[index]);
      }
    }

    return output;
  }

  pendingCount(): number {
    return this.pendingInserts.size + this.pendingDeletes.size;
  }

  snapshot(): TextCrdtSnapshot {
    return {
      replicaId: this.replicaId,
      counter: this.counter,
      elements: Array.from(this.elements.values()).map((element) => ({
        id: cloneElementId(element.id),
        value: element.value,
        parentId: cloneParentId(element.parentId),
        deleted: element.deleted
      })),
      seenOpIds: Array.from(this.seenOpIds.values()),
      pendingInserts: Array.from(this.pendingInserts.values()).map(cloneInsertOp),
      pendingDeletes: Array.from(this.pendingDeletes.values()).map(cloneDeleteOp)
    };
  }

  debugState(): unknown {
    return {
      replicaId: this.replicaId,
      counter: this.counter,
      text: this.toString(),
      elements: this.snapshot().elements,
      seenOpIds: Array.from(this.seenOpIds.values()).sort(),
      pendingInserts: Array.from(this.pendingInserts.values()),
      pendingDeletes: Array.from(this.pendingDeletes.values())
    };
  }

  private applyInsert(operation: InsertOp): void {
    const opId = idKey(operation.opId);
    if (this.elements.has(opId)) {
      return;
    }

    const element: CharElement = {
      id: cloneElementId(operation.opId),
      value: operation.value,
      parentId: cloneParentId(operation.parentId),
      deleted: false
    };

    this.elements.set(opId, element);
    const siblings = this.ensureChildren(operation.parentId);
    siblings.push(cloneElementId(operation.opId));
    siblings.sort(compareElementIdDescending);
    this.ensureChildren(operation.opId);

    if (operation.opId.replicaId === this.replicaId) {
      this.counter = Math.max(this.counter, operation.opId.counter);
    }
  }

  private applyDelete(operation: DeleteOp): void {
    const element = this.elements.get(idKey(operation.targetId));
    if (element) {
      element.deleted = true;
    }

    if (operation.opId.replicaId === this.replicaId) {
      this.counter = Math.max(this.counter, operation.opId.counter);
    }
  }

  private drainPending(): number {
    let drained = 0;
    let progressed = true;

    while (progressed) {
      progressed = false;

      for (const [opId, op] of Array.from(this.pendingInserts.entries())) {
        if (this.hasParent(op.parentId)) {
          this.pendingInserts.delete(opId);
          this.applyInsert(op);
          drained += 1;
          progressed = true;
        }
      }

      for (const [opId, op] of Array.from(this.pendingDeletes.entries())) {
        if (this.elements.has(idKey(op.targetId))) {
          this.pendingDeletes.delete(opId);
          this.applyDelete(op);
          drained += 1;
          progressed = true;
        }
      }
    }

    return drained;
  }

  private hasParent(parentId: ParentId): boolean {
    return parentId === "ROOT" || this.elements.has(idKey(parentId));
  }

  private ensureChildren(parentId: ParentId): ElementId[] {
    const key = idKey(parentId);
    const existing = this.children.get(key);
    if (existing) {
      return existing;
    }

    const created: ElementId[] = [];
    this.children.set(key, created);
    return created;
  }

  private rebuildChildren(): void {
    this.children.clear();
    this.children.set("ROOT", []);

    for (const element of this.elements.values()) {
      this.ensureChildren(element.parentId).push(cloneElementId(element.id));
      this.ensureChildren(element.id);
    }

    for (const children of this.children.values()) {
      children.sort(compareElementIdDescending);
    }
  }
}

function cloneInsertOp(op: InsertOp): InsertOp {
  return {
    type: "insert",
    opId: cloneElementId(op.opId),
    parentId: cloneParentId(op.parentId),
    value: op.value
  };
}

function cloneDeleteOp(op: DeleteOp): DeleteOp {
  return {
    type: "delete",
    opId: cloneElementId(op.opId),
    targetId: cloneElementId(op.targetId)
  };
}

function maxCounterForReplica(snapshot: TextCrdtSnapshot, replicaId: ReplicaId): number {
  let max = snapshot.replicaId === replicaId ? snapshot.counter : 0;

  for (const element of snapshot.elements) {
    if (element.id.replicaId === replicaId) {
      max = Math.max(max, element.id.counter);
    }
  }

  for (const op of [...snapshot.pendingInserts, ...snapshot.pendingDeletes]) {
    if (op.opId.replicaId === replicaId) {
      max = Math.max(max, op.opId.counter);
    }
  }

  for (const opId of snapshot.seenOpIds) {
    const separator = opId.lastIndexOf(":");
    if (separator <= 0) {
      continue;
    }

    const seenReplicaId = opId.slice(0, separator);
    const counter = Number(opId.slice(separator + 1));
    if (seenReplicaId === replicaId && Number.isInteger(counter)) {
      max = Math.max(max, counter);
    }
  }

  return max;
}
