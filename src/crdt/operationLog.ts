import { CrdtOperation } from "./types";
import { idKey } from "./types";

export class OperationLog {
  private readonly operations: CrdtOperation[] = [];
  private readonly seen = new Set<string>();

  append(operation: CrdtOperation): boolean {
    const key = idKey(operation.opId);
    if (this.seen.has(key)) {
      return false;
    }

    this.seen.add(key);
    this.operations.push(operation);
    return true;
  }

  has(operation: CrdtOperation): boolean {
    return this.seen.has(idKey(operation.opId));
  }

  all(): CrdtOperation[] {
    return [...this.operations];
  }

  size(): number {
    return this.operations.length;
  }
}
