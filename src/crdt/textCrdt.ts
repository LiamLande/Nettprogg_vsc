/**
 * TypeScript shim around the Rust CRDT compiled to WebAssembly.
 *
 * All CRDT logic lives in `crates/crdt-core`. Build the module with
 * `npm run build:wasm` before running the extension.
 */
import { CrdtOperation, DeleteOp, ElementId, InsertOp, ParentId } from "./types";
import { isOperation } from "./serializer";
import * as path from "node:path";

export type ApplyResult = {
  status: "applied" | "duplicate" | "queued";
  opId: string;
  drained: number;
};

export type CharSnapshot = {
  id: ElementId;
  value: string;
  parentId: ParentId;
  deleted: boolean;
};

export type TextCrdtSnapshot = {
  replicaId: string;
  counter: number;
  elements: CharSnapshot[];
  seenOpIds: string[];
  pendingInserts: InsertOp[];
  pendingDeletes: DeleteOp[];
};

/**
 * Shape of the auto-generated WASM module produced by
 * `wasm-pack build --target nodejs`.
 */
interface WasmTextCrdtInstance {
  insert(index: number, text: string): CrdtOperation[];
  delete(index: number, count: number): CrdtOperation[];
  applyOperation(op: CrdtOperation): ApplyResult;
  hasSeen(op: CrdtOperation): boolean;
  snapshot(): TextCrdtSnapshot;
  debugState(): unknown;
  toString(): string;
  visibleLength(): number;
  pendingCount(): number;
  getReplicaId(): string;
}

interface WasmTextCrdtCtor {
  new (replicaId: string): WasmTextCrdtInstance;
  fromSnapshot(snapshot: TextCrdtSnapshot, replicaId: string): WasmTextCrdtInstance;
}

interface WasmModule {
  TextCrdt: WasmTextCrdtCtor;
}

let cachedWasmModule: WasmModule | undefined;

function loadWasmModule(): WasmModule {
  if (cachedWasmModule) {
    return cachedWasmModule;
  }

  const candidates = [
    // Prefer a bundled `dist/wasm/crdt` when running from a packaged layout,
    // fall back to the source paths for local development.
    path.resolve(__dirname, "../../dist/wasm/crdt"),
    "../wasm/crdt",
    path.resolve(__dirname, "../../src/wasm/crdt")
  ];
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cachedWasmModule = require(candidate) as WasmModule;
      return cachedWasmModule;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate}: ${reason}`);
    }
  }

  throw new Error(
    "LiveShare Lite CRDT WebAssembly module is not available. " +
      "Build it first with `npm run build:wasm` (requires `wasm-pack`). " +
      `Tried: ${errors.join(" | ")}`
  );
}

/**
 * Synchronous wrapper around the Rust + WASM CRDT.
 *
 * The WASM module is loaded eagerly on construction so a missing build fails
 * immediately rather than on the first edit.
 */
export class TextCrdt {
  private inner!: WasmTextCrdtInstance;

  constructor(replicaId: string) {
    const mod = loadWasmModule();
    this.inner = new mod.TextCrdt(replicaId);
  }

  /** Reconstructs a CRDT from a snapshot, adopting `replicaId` for future operations. */
  static fromSnapshot(snapshot: TextCrdtSnapshot, replicaId: string): TextCrdt {
    const mod = loadWasmModule();
    const instance = Object.create(TextCrdt.prototype) as TextCrdt;
    (instance as unknown as { inner: WasmTextCrdtInstance }).inner =
      mod.TextCrdt.fromSnapshot(snapshot, replicaId);
    return instance;
  }

  /**
   * Inserts `text` at visible position `index`.
   * Returns one {@link InsertOp} per character; all are applied locally immediately.
   */
  insert(index: number, text: string): InsertOp[] {
    if (text.length === 0) {
      return [];
    }
    const ops = this.inner.insert(index, text);
    return ops.map((op) => {
      if (!isOperation(op) || op.type !== "insert") {
        throw new Error("WASM CRDT returned a non-insert operation from insert().");
      }
      return op;
    });
  }

  /**
   * Tombstones `count` consecutive visible characters starting at `index`.
   * Returns one {@link DeleteOp} per character.
   */
  delete(index: number, count = 1): DeleteOp[] {
    if (count <= 0) {
      return [];
    }
    const ops = this.inner.delete(index, count);
    return ops.map((op) => {
      if (!isOperation(op) || op.type !== "delete") {
        throw new Error("WASM CRDT returned a non-delete operation from delete().");
      }
      return op;
    });
  }

  /**
   * Applies a remote operation to this replica.
   * Idempotent — duplicate operations are silently ignored.
   */
  applyOperation(op: CrdtOperation): ApplyResult {
    return this.inner.applyOperation(op);
  }

  /** Returns `true` if `op` has already been applied or buffered. */
  hasSeen(op: CrdtOperation): boolean {
    return this.inner.hasSeen(op);
  }

  /** Serialises the full replica state for transfer to a joining peer. */
  snapshot(): TextCrdtSnapshot {
    return this.inner.snapshot();
  }

  /** Full internal state for the extension's debug command. */
  debugState(): unknown {
    return this.inner.debugState();
  }

  /** Current visible document text. */
  toString(): string {
    return this.inner.toString();
  }

  /** Visible document length in Unicode scalar values. */
  visibleLength(): number {
    return this.inner.visibleLength();
  }

  /** Number of operations buffered pending their dependency. */
  pendingCount(): number {
    return this.inner.pendingCount();
  }

  /** This replica's id string. */
  getReplicaId(): string {
    return this.inner.getReplicaId();
  }
}
