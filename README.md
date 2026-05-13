# LiveShare Lite

LiveShare Lite is a proof-of-concept VS Code extension for collaborative text editing with a custom operation-based text CRDT. Each client keeps an independent replica of the document. The WebSocket server only relays and replays operations; conflict handling happens in the clients.

## Latest CI/CD Run

Add the GitHub Actions badge after pushing this repository to GitHub:

```md
![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)
```

## Implemented Functionality

- VS Code commands for starting a relay server, starting a session, joining a session, leaving and showing debug state
- CRDT-based synchronization of one active text document
- Custom RGA-inspired text CRDT with tombstones and pending operation buffers
- WebSocket relay server with rooms, operation replay and reconnect support
- Duplicate, delayed and out-of-order operations are idempotent
- Status bar connection state and participant count
- Unit, convergence, randomized and relay server tests
- CI workflow for compile and test

## Architecture

```text
VS Code extension ── CRDT operations ── WebSocket relay ── CRDT operations ── VS Code extension
```

See [docs/architecture.md](docs/architecture.md) for the full flow.

## CRDT Design

The CRDT stores one element per inserted UTF-16 code unit:

```ts
type ElementId = { counter: number; replicaId: string };
type CharElement = {
  id: ElementId;
  value: string;
  parentId: ElementId | "ROOT";
  deleted: boolean;
};
```

Inserts reference the previous element, deletes mark tombstones, duplicate operation IDs are ignored and operations with missing dependencies are buffered. Siblings are ordered deterministically by descending `(counter, replicaId)`.

See [docs/crdt-design.md](docs/crdt-design.md).

## Installation

```bash
npm install
npm run compile
```

## Usage

1. Start the relay: `npm run start:server`
2. Press `F5` in VS Code to launch an Extension Development Host.
3. Run `LiveShare Lite: Start Session`.
4. Open another Extension Development Host or VS Code window.
5. Run `LiveShare Lite: Join Session` with the same room ID and server URL.
6. Edit the active text file.

You can also run `LiveShare Lite: Start Server` from inside the extension host.

## Running Tests

```bash
npm test
npm run test:crdt
npm run test:server
npm run test:extension-host
```

## Benchmark

```bash
npm run bench
```

The benchmark inserts documents of 100, 1,000 and 10,000 characters and prints elapsed time and heap usage.

## External Dependencies

- `vscode` API types for the extension surface
- `ws` for WebSocket transport
- `vitest` for tests
- `fast-check` for randomized convergence tests
- `typescript` and `tsx` for build scripts

No production CRDT library such as Yjs or Automerge is used. The CRDT is implemented in `src/crdt`.

## Current Limitations / Future Work

- One active text file only
- No authentication beyond room ID
- No workspace/file tree sync
- No shared cursor rendering
- No CRDT-aware undo/redo
- Tombstones are not compacted
- Rich text and binary files are not supported
