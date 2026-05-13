import { describe, expect, it } from "vitest";
import { TextCrdt } from "../src/crdt/textCrdt";
import { DeleteOp, InsertOp, elementId } from "../src/crdt/types";

describe("TextCrdt unit behavior", () => {
  it("inserts a single character", () => {
    const crdt = new TextCrdt("A");
    crdt.insert(0, "x");
    expect(crdt.toString()).toBe("x");
  });

  it("inserts multiple characters as a parent chain", () => {
    const crdt = new TextCrdt("A");
    crdt.insert(0, "hello");
    expect(crdt.toString()).toBe("hello");
  });

  it("deletes a visible character with a tombstone", () => {
    const crdt = new TextCrdt("A");
    crdt.insert(0, "abc");
    crdt.delete(1);
    expect(crdt.toString()).toBe("ac");
  });

  it("ignores duplicate operations", () => {
    const a = new TextCrdt("A");
    const [op] = a.insert(0, "x");
    const b = new TextCrdt("B");

    expect(b.applyOperation(op).status).toBe("applied");
    expect(b.applyOperation(op).status).toBe("duplicate");
    expect(b.toString()).toBe("x");
  });

  it("queues delete before matching insert arrives", () => {
    const insert: InsertOp = {
      type: "insert",
      opId: elementId(1, "A"),
      parentId: "ROOT",
      value: "x"
    };
    const del: DeleteOp = {
      type: "delete",
      opId: elementId(1, "B"),
      targetId: insert.opId
    };
    const crdt = new TextCrdt("C");

    expect(crdt.applyOperation(del).status).toBe("queued");
    expect(crdt.applyOperation(insert).status).toBe("applied");
    expect(crdt.toString()).toBe("");
    expect(crdt.pendingCount()).toBe(0);
  });

  it("queues insert until parent arrives", () => {
    const parent: InsertOp = {
      type: "insert",
      opId: elementId(1, "A"),
      parentId: "ROOT",
      value: "a"
    };
    const child: InsertOp = {
      type: "insert",
      opId: elementId(2, "A"),
      parentId: parent.opId,
      value: "b"
    };
    const crdt = new TextCrdt("C");

    expect(crdt.applyOperation(child).status).toBe("queued");
    expect(crdt.applyOperation(parent).status).toBe("applied");
    expect(crdt.toString()).toBe("ab");
    expect(crdt.pendingCount()).toBe(0);
  });

  it("orders concurrent inserts at the same parent deterministically", () => {
    const insertA: InsertOp = {
      type: "insert",
      opId: elementId(1, "A"),
      parentId: "ROOT",
      value: "x"
    };
    const insertB: InsertOp = {
      type: "insert",
      opId: elementId(1, "B"),
      parentId: "ROOT",
      value: "y"
    };

    const left = new TextCrdt("left");
    const right = new TextCrdt("right");
    left.applyOperation(insertA);
    left.applyOperation(insertB);
    right.applyOperation(insertB);
    right.applyOperation(insertA);

    expect(left.toString()).toBe("yx");
    expect(right.toString()).toBe("yx");
  });

  it("hydrates snapshots with the joining replica id for future operations", () => {
    const source = new TextCrdt("A");
    source.insert(0, "abc");

    const joined = TextCrdt.fromSnapshot(source.snapshot(), "B");
    const [op] = joined.insert(joined.visibleLength(), "!");

    expect(joined.getReplicaId()).toBe("B");
    expect(op.opId).toEqual({ counter: 1, replicaId: "B" });
    expect(joined.toString()).toBe("abc!");
  });

  it("keeps future operation ids unique when a snapshot already contains local replica ops", () => {
    const source = new TextCrdt("A");
    const bOp = new TextCrdt("B").insert(0, "b")[0];
    source.applyOperation(bOp);

    const joined = TextCrdt.fromSnapshot(source.snapshot(), "B");
    const [nextOp] = joined.insert(joined.visibleLength(), "!");

    expect(nextOp.opId).toEqual({ counter: 2, replicaId: "B" });
  });
});
