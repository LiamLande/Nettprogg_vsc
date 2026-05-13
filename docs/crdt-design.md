# CRDT Design

The text model is an operation-based, RGA-inspired sequence CRDT. Each inserted UTF-16 code unit becomes a `CharElement`.

```ts
type ElementId = { counter: number; replicaId: string };
type CharElement = {
  id: ElementId;
  value: string;
  parentId: ElementId | "ROOT";
  deleted: boolean;
};
```

## Insert

An insert points to the element directly before the insertion position. Multiple inserted characters are represented as a parent chain. If an insert arrives before its parent, it is stored in a pending buffer until the parent appears.

## Delete

A delete points to an existing element ID and marks it as a tombstone. Deletes are idempotent. If a delete arrives before the matching insert, it is stored in a pending buffer.

## Ordering

Children under the same parent are sorted deterministically by descending `(counter, replicaId)`. Newer siblings are rendered closer to the parent, which preserves local insert-at-position behavior when inserting before an older successor. All replicas use the same traversal and sorting rule, so concurrent inserts at the same position render deterministically.

## Convergence Properties Tested

- duplicate operations are ignored
- inserts can arrive before parents
- deletes can arrive before inserts
- operations can be delivered in different orders
- offline replicas converge after all operations are delivered
- randomized simulations include duplicate and shuffled delivery

## Current Limitations

- The CRDT stores tombstones and does not compact them.
- Cursor and selection positions are not shared.
- Text is modeled as UTF-16 code units to match VS Code offsets, not Unicode grapheme clusters.
- Undo/redo semantics are delegated to VS Code and are not CRDT-aware.
