import { describe, expect, it } from "vitest";
import { TextCrdt } from "../src/crdt/textCrdt";
import { CrdtOperation } from "../src/crdt/types";

describe("TextCrdt convergence", () => {
  it("converges across three replicas with out-of-order delivery", () => {
    const a = new TextCrdt("A");
    const b = new TextCrdt("B");
    const c = new TextCrdt("C");

    const ops: CrdtOperation[] = [
      ...a.insert(0, "ab"),
      ...b.insert(0, "xy"),
      ...c.insert(0, "12")
    ];

    for (const op of [...ops].reverse()) {
      a.applyOperation(op);
    }
    for (const op of [ops[2], ops[0], ops[5], ops[1], ops[4], ops[3]]) {
      b.applyOperation(op);
    }
    for (const op of ops) {
      c.applyOperation(op);
      c.applyOperation(op);
    }

    expect(a.toString()).toEqual(b.toString());
    expect(b.toString()).toEqual(c.toString());
  });

  it("converges after offline edits and reconnect delivery", () => {
    const a = new TextCrdt("A");
    const b = new TextCrdt("B");
    const c = new TextCrdt("C");

    const onlineOps = a.insert(0, "hello");
    for (const op of onlineOps) {
      b.applyOperation(op);
    }

    const offlineA = [...a.delete(1, 2), ...a.insert(1, "A")];
    const offlineB = b.insert(5, "B");
    const offlineC = c.insert(0, "C");
    const allOps = [...onlineOps, ...offlineA, ...offlineB, ...offlineC];

    for (const replica of [a, b, c]) {
      for (const op of [...allOps].reverse()) {
        replica.applyOperation(op);
      }
    }

    expect(a.toString()).toEqual(b.toString());
    expect(b.toString()).toEqual(c.toString());
    expect(a.pendingCount()).toBe(0);
    expect(b.pendingCount()).toBe(0);
    expect(c.pendingCount()).toBe(0);
  });
});
