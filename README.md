# LiveShare Lite

LiveShare Lite is a proof-of-concept Visual Studio Code extension for real-time
collaborative text editing built on top of a custom, operation-based CRDT.

The entire collaboration engine — CRDT, relay server and WebRTC signaling
server — is implemented in Rust. The CRDT compiles to WebAssembly and is loaded
synchronously by the VS Code extension. Only the extension shell itself (VS
Code commands, document adapter, transport plumbing) remains in TypeScript,
because the VS Code extension API only runs inside the Node.js extension host.

> **Assignment context.** Built for the NTNU `IDATG2003 Nettverksprogrammering`
> CRDT bonus project. The point of the project is to design a usable CRDT and
> show that it converges under realistic distributed conditions (offline,
> duplicate, out-of-order, concurrent edits).

## Continuous Integration

GitHub Actions runs both Rust (`cargo fmt`, `cargo clippy`, `cargo test`) and
TypeScript (`tsc` + `vitest`) on every push and pull request: _

[CI](https://github.com/LiamLande/Nettprogg_vsc/actions/workflows/ci.yml/badge.svg)


## Implemented Functionality

### CRDT (`crates/crdt-core`)

- Custom **operation-based, RGA-inspired text CRDT** that stores one element
  per inserted character. Insert operations reference a parent element; delete
  operations flip a tombstone flag. Siblings under the same parent are ordered
  deterministically by descending `(counter, replica_id)` so every replica
  converges to the same visible text.
- **Idempotent application.** Each operation has a globally unique
  `(counter, replicaId)` id and is deduplicated.
- **Out-of-order delivery.** Operations whose parent or target is missing are
  buffered and drained transitively the moment the missing dependency arrives.
- **Version vector** and append-only **operation log** for missing-operation
  detection and replay.
- **Snapshots** for late joiners. A new replica can adopt the snapshot of an
  existing replica without losing operation id uniqueness.

### Network layer

- **Rust relay server** (`crates/relay-server`) — WebSocket server that keeps
  one operation log per room, replays missing operations to reconnecting
  clients, and broadcasts new operations to all peers in the room.
- **Rust signaling server** (`crates/signaling-server`) — WebSocket server
  that only forwards WebRTC `description` / `candidate` payloads between
  named peers and tracks per-room presence. It never sees CRDT operations.
- Both servers are **wire-compatible** with the original TypeScript reference
  implementation, so the existing TypeScript transports in
  `src/transport/*.ts` plug into the Rust servers unchanged.

### VS Code extension (`src/extension`)

- Commands: `Start Server`, `Start Signaling Server`, `Start Session`,
  `Join Session`, `Leave Session`, `Force Shutdown`, `Show Debug State`,
  `Run Local CRDT Demo`.
- The "Start Server" / "Start Signaling Server" commands launch the Rust
  binaries as background child processes (via `LocalRustServer`). They look
  for a prebuilt binary at `crates/target/release/<kind>-server[.exe]` first
  and fall back to `cargo run` so a fresh checkout can host a session
  without an extra build step.
- Status bar with connection state and peer count; structured output channel
  for debugging.
- Two transports: a WebSocket **relay** (default) and a **WebRTC mesh** that
  uses the signaling server only for connection setup and exchanges
  operations + CRDT snapshots over peer-to-peer DataChannels.

### Tests

- Cargo unit tests covering insert/delete semantics, deterministic concurrent
  ordering, idempotency, queueing, and snapshot rehydration.
- Cargo integration tests for the relay server (joined → operation → echoed
  back to peers; replay log delivered to late joiners) and the signaling
  server (`signal` forwarding, `peerLeft` broadcast on close).
- Cargo property-style randomised convergence test that runs 30 different
  three-replica simulations with shuffled and duplicated operation delivery.
- TypeScript packaging test (`vitest`) verifying the extension contributes the
  expected commands.

## Architecture

```text
┌──────────────────────────┐    ws / JSON ops      ┌──────────────────────────┐
│  VS Code extension       │ ───────────────────▶  │  Rust relay server       │
│  (TypeScript)            │                       │  crates/relay-server     │
│                          │ ◀───────────────────  │                          │
│  ┌────────────────────┐  │      replay + echo    │  - room registry         │
│  │  CRDT (Rust WASM)  │  │                       │  - per-room op log       │
│  └────────────────────┘  │                       │  - presence broadcast    │
└──────────────────────────┘                       └──────────────────────────┘
```

In WebRTC mode the relay is replaced by a thin signaling server that exchanges
SDP / ICE only, and operations + snapshots flow directly between peers over
DataChannels.

## CRDT Design

An [`ElementId`](crates/crdt-core/src/id.rs) is the pair `(counter, replicaId)`.
Each replica owns a strictly increasing counter, so ids are globally unique
forever. The visible document is the depth-first in-order walk through the
non-deleted descendants of the synthetic `ROOT` parent. Siblings are sorted
descending by `(counter, replicaId)` so all replicas converge identically.

```text
ROOT ── (1, A) "h"
       └─ (2, A) "i"
ROOT ── (1, B) "?"      // concurrent insert at ROOT, ordered after A's
```

The same logic handles deletes: each delete marks one target element as a
tombstone, which is invisible but never removed from the tree.

Operations with missing parents (insert) or missing targets (delete) are
buffered in `pending_inserts` / `pending_deletes` until the dependency
arrives, at which point they are drained transitively. Each replica also
tracks every `op_id` it has ever seen, so duplicate delivery is a silent
no-op.

For full algorithm notes see [`docs/crdt-design.md`](docs/crdt-design.md).

## Project Structure

```text
.
├── crates/                          # Rust workspace
│   ├── Cargo.toml                   # workspace manifest
│   ├── crdt-core/                   # pure CRDT library (no I/O)
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── id.rs                # ElementId, ParentId
│   │   │   ├── operation.rs         # Operation, InsertOp, DeleteOp, ApplyResult
│   │   │   ├── operation_log.rs
│   │   │   ├── version_vector.rs
│   │   │   ├── snapshot.rs
│   │   │   ├── text_crdt.rs         # main CRDT
│   │   │   └── error.rs
│   │   └── tests/                   # convergence, dedup, out-of-order, randomized
│   ├── crdt-wasm/                   # wasm-bindgen bindings around crdt-core
│   ├── protocol/                    # shared wire-protocol message types
│   ├── relay-server/                # WebSocket operation-relay binary
│   └── signaling-server/            # WebSocket WebRTC signaling binary
├── src/                             # TypeScript VS Code extension
│   ├── crdt/                        # thin shim around the Rust WASM CRDT
│   ├── extension/                   # SessionManager, commands, status bar,
│   │                                # LocalRustServer child-process launcher
│   ├── transport/                   # relay and WebRTC P2P transports
│   └── shared/                      # TS-side wire-format types
├── test/                            # vitest packaging tests
├── docs/                            # architecture + demo notes
├── package.json
└── tsconfig.json
```

## Installation

Two supported setups: a native toolchain on the host, or a Dockerised relay /
signaling stack with the VS Code extension running natively.

### Option A — native toolchain (recommended for development)

Requires:

- **Node.js 20+** for the VS Code extension build.
- **Rust stable** (with `cargo`) for the CRDT and the two servers.
- **`wasm-pack`** to build the WASM CRDT for the extension. Install with:
  ```bash
  cargo install wasm-pack
  ```
- *(Optional)* `make` for the convenience targets in the [Makefile](Makefile).

One-shot bootstrap with the Makefile:

```bash
make setup
```

Or with npm / cargo directly:

```bash
npm install                     # JS dependencies
npm run rust:release            # cargo build --release for relay + signaling
npm run build:wasm              # compiles crates/crdt-wasm into src/wasm/crdt/
npm run compile                 # tsc → dist/
```

> **Build order matters.** The VS Code extension loads the WASM CRDT via
> `require("../wasm/crdt")` at runtime. The TypeScript code compiles without
> WASM, but starting a session requires `npm run build:wasm` first.

### Option B — Dockerised servers

Requires only **Docker** and **Docker Compose** on the host plus a local
Node + Rust toolchain to build the VS Code extension (`make build-ts` and
`make build-wasm`).

```bash
make docker-up      # build the image, start relay (7071) and signaling (7072)
make docker-logs    # tail the container logs
make docker-down    # stop both containers
```

The Dockerfile is a multi-stage build:

1. `rust:1.83-slim-bookworm` compiles `relay-server` and `signaling-server`.
2. `debian:bookworm-slim` ships the binaries under a non-root `app` user, and
   the entrypoint is overridden per service in `docker-compose.yml`.

Both services listen on `0.0.0.0` inside the container; Docker publishes them
on the host at the same port numbers. Switch the host-side mapping if those
ports are taken.

## Usage

### Quick start (one machine, two windows)

1. Build the workspace once: `npm install && npm run rust:release && npm run build:wasm && npm run compile`.
2. Open the project in VS Code and press `F5`. An Extension Development Host
   window appears with LiveShare Lite installed.
3. In the dev host, run `LiveShare Lite: Start Server` and confirm port 7071.
   The relay binary launches as a background child process.
4. Run `LiveShare Lite: Start Session`. Accept the random room id (or type one).
5. Open a second VS Code window on the same machine and press `F5` again to
   open another Extension Development Host.
6. In the second host, run `LiveShare Lite: Join Session` and type the same
   room id.
7. Open or create a text file in both windows and start typing. Edits propagate
   live; presence is shown in the status bar.

### Two machines

1. Build everything on both machines (or copy the `crates/target/release/`
   binary plus `dist/` and `src/wasm/`).
2. On the host machine, run `LiveShare Lite: Start Server` (or
   `npm run rust:start:relay` in a separate terminal) and note the host's IP.
3. Open the firewall on port 7071.
4. On the guest machine, run `LiveShare Lite: Join Session` and enter
   `ws://<host-ip>:7071` as the relay URL.

### WebRTC mode

1. Set `liveshareLite.transportMode` to `p2p` in VS Code settings.
2. Run `LiveShare Lite: Start Signaling Server` on one machine.
3. Start / join the session using the same signaling URL. The signaling server
   only forwards offers/answers and never sees document operations.

## Running Tests

Both suites at once:

```bash
make test
```

Rust (canonical CRDT and server tests):

```bash
make test-rust            # or: cargo test --manifest-path crates/Cargo.toml
```

TypeScript packaging tests:

```bash
make test-ts              # or: npm test
```

Formatting and lint checks:

```bash
make lint
```

The Rust suite covers 31 cases: 18 CRDT unit tests, 7 CRDT integration tests
(convergence, dedup, out-of-order, randomised), 2 protocol round-trip tests,
2 relay-server WebSocket integration tests, and 2 signaling-server WebSocket
integration tests.

## Common Make Targets

```text
make help            list every target
make setup           one-shot bootstrap (npm install + cargo + wasm-pack + tsc)
make build           build everything
make test            run cargo and vitest suites
make run-relay       run the relay server (foreground)
make run-signaling   run the signaling server (foreground)
make free-ports      kill any process holding 7071 or 7072
make docker-up       start the relay + signaling containers
make docker-down     stop the containers
make clean           remove all build artefacts
make cleanup-deprecated   delete TypeScript stubs and migration docs
```

## API Documentation

Generate Rustdoc for the Rust workspace:

```bash
cargo doc --no-deps --open --manifest-path crates/Cargo.toml
```

## External Dependencies

### Rust workspace

| Crate                 | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `serde` + `serde_json`| Serialise CRDT operations and wire messages so the JSON matches the TypeScript reference format byte-for-byte. |
| `tokio`               | Async runtime for the relay and signaling servers (multi-threaded, IO, signals). |
| `tokio-tungstenite`   | WebSocket implementation on top of `tokio`. Pinned to 0.21 for the `Message::Text(String)` API. |
| `futures-util`        | `Sink` / `Stream` combinators used to split a WebSocket connection. |
| `anyhow`              | Ergonomic error type for the server main loops.                      |
| `thiserror`           | Strongly-typed errors inside `crdt-core`.                            |
| `tracing` + `tracing-subscriber` | Structured logs from the servers.                          |
| `serde-wasm-bindgen`  | Converts between `JsValue` and Rust types in the WASM bridge.        |
| `wasm-bindgen`        | Generates the JS/WASM glue for the CRDT bridge.                      |
| `console_error_panic_hook` | Forwards Rust panics to the browser/Node console.               |
| `rand`                | Used only in the randomised convergence test.                        |

### TypeScript extension

| Package          | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `vscode` types   | VS Code extension API surface.                                     |
| `ws`             | WebSocket client for the relay transport on the Node.js side.      |
| `node-datachannel` | WebRTC DataChannels inside the VS Code extension host.           |
| `typescript`     | Compiler for the extension.                                        |
| `vitest`         | Packaging smoke tests in `test/extension.test.ts`.                 |
| `wasm-pack` *(installed via `cargo install`)* | Builds `crates/crdt-wasm` into the `src/wasm/crdt/` package that the extension loads at runtime. |

**No third-party CRDT library** (Automerge, Yjs, diamond-types, …) is used.
The entire CRDT is implemented in this repository.

## Current Limitations and Future Work

- Single active text file per session.
- ASCII / Basic Multilingual Plane characters only. Non-BMP characters
  (e.g. emoji) are stored as one CRDT element while VS Code reports them as
  two UTF-16 code units, which can desync indices. Out of scope for the PoC.
- No authentication beyond a shared room id.
- No workspace / file-tree sync, no shared cursor rendering, no CRDT-aware
  undo/redo.
- Tombstones are never compacted.
- WebRTC mode does not include TURN fallback; both peers need usable STUN/ICE.
- Binary / rich-text documents are not supported.

Possible follow-ups: persistent op log on the server, per-document sessions,
multi-document tree sync, shared cursors, TURN integration, performance
benchmarking against Automerge or Yjs.

## External Information Used

- Algorithm reference: *Conflict-free Replicated Data Types* (Wikipedia) and
  Martin Kleppmann's lecture *CRDTs: The Hard Parts*. No external code was
  copied; the RGA-inspired tree structure was reimplemented from the
  algorithm descriptions in these sources.
- Rust standard library, `tokio`, `tokio-tungstenite` and `serde` reference
  documentation for async networking and serialization patterns.
- `wasm-bindgen` and `serde-wasm-bindgen` guides for the JS/WASM bridge.

## Migration and Cleanup Notes

This repository started life as a pure-TypeScript prototype. The migration to
Rust is complete:

- `src/crdt/*.ts` (CRDT, version vector, operation log) → `crates/crdt-core`.
- `src/server/*.ts` (relay + signaling) → `crates/relay-server` and `crates/signaling-server`.
- `src/extension/*.ts` was kept in TypeScript because the VS Code extension
  API only runs inside the Node.js extension host. The extension loads the
  Rust CRDT through a WebAssembly bridge generated by `wasm-pack`.

If you cloned the repository before the migration finished, run

```bash
make cleanup-deprecated
```

to delete the remaining TypeScript stubs, the old transition documents, and
the legacy `rust-workspace/` folder.
