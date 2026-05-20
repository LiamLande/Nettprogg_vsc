/**
 * Thin TypeScript shim around the Rust CRDT compiled to WebAssembly.
 *
 * All CRDT logic lives in the Rust crate `crates/crdt-core`. This file only
 * loads the WASM module (built with `npm run build:wasm`) and exposes a
 * synchronous, class-based API that mirrors the previous TypeScript
 * implementation so the rest of the VS Code extension does not need to
 * change.
 *
 * The wire format produced and consumed by the WASM CRDT is byte-for-byte
 * identical to what the Rust relay server understands, so JSON operations
 * flow through `extension → WASM → relay → WASM → extension` without any
 * reshaping.
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
 * Synchronous TypeScript wrapper around the Rust + WASM CRDT.
 *
 * Construction loads the WASM module eagerly, so a misconfigured build
 * fails fast rather than the next time an edit happens.
 */
export class TextCrdt {
  private inner!: WasmTextCrdtInstance;

  constructor(replicaId: string) {
    const mod = loadWasmModule();
    this.inner = new mod.TextCrdt(replicaId);
  }

  /** Re-hydrate from a snapshot, adopting `replicaId` as the new identity. */
  static fromSnapshot(snapshot: TextCrdtSnapshot, replicaId: string): TextCrdt {
    const mod = loadWasmModule();
    const instance = Object.create(TextCrdt.prototype) as TextCrdt;
    (instance as unknown as { inner: WasmTextCrdtInstance }).inner =
      mod.TextCrdt.fromSnapshot(snapshot, replicaId);
    return instance;
  }

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

  applyOperation(op: CrdtOperation): ApplyResult {
    return this.inner.applyOperation(op);
  }

  hasSeen(op: CrdtOperation): boolean {
    return this.inner.hasSeen(op);
  }

  snapshot(): TextCrdtSnapshot {
    return this.inner.snapshot();
  }

  debugState(): unknown {
    return this.inner.debugState();
  }

  toString(): string {
    return this.inner.toString();
  }

  visibleLength(): number {
    return this.inner.visibleLength();
  }

  pendingCount(): number {
    return this.inner.pendingCount();
  }

  getReplicaId(): string {
    return this.inner.getReplicaId();
  }
}
