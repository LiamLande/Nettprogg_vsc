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
});
