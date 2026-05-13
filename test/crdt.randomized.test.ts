import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TextCrdt } from "../src/crdt/textCrdt";
import { CrdtOperation } from "../src/crdt/types";

type Action = {
  replica: number;
  kind: "insert" | "delete";
  index: number;
  value: string;
};

describe("TextCrdt randomized simulations", () => {
  it("converges after delayed, duplicate and shuffled operation delivery", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            replica: fc.integer({ min: 0, max: 2 }),
            kind: fc.constantFrom<"insert" | "delete">("insert", "delete"),
            index: fc.nat(50),
            value: fc.constantFrom("a", "b", "c", "x", "y", "z", "\n")
          }),
          { minLength: 1, maxLength: 80 }
        ),
        fc.integer(),
        (actions, seed) => {
          const replicas = [new TextCrdt("A"), new TextCrdt("B"), new TextCrdt("C")];
          const operations: CrdtOperation[] = [];

          for (const action of actions) {
            operations.push(...applyAction(replicas[action.replica], action));
          }

          const delivery = shuffle([...operations, ...operations.filter((_, index) => index % 3 === 0)], seed);
          for (const replica of replicas) {
            for (const op of delivery) {
              replica.applyOperation(op);
            }
          }

          expect(replicas[0].toString()).toEqual(replicas[1].toString());
          expect(replicas[1].toString()).toEqual(replicas[2].toString());
        }
      ),
      { numRuns: 100 }
    );
  });
});

function applyAction(replica: TextCrdt, action: Action): CrdtOperation[] {
  const length = replica.visibleLength();
  if (action.kind === "insert") {
    return replica.insert(action.index % (length + 1), action.value);
  }

  if (length === 0) {
    return [];
  }

  return replica.delete(action.index % length);
}

function shuffle<T>(items: T[], seed: number): T[] {
  const output = [...items];
  let state = Math.abs(seed) || 1;

  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const swapIndex = state % (index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }

  return output;
}
