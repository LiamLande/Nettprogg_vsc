# LiveShare Lite: Quick Start

## Prerequisites

- Node.js 20+
- Rust stable (`rustc`, `cargo`)
- `wasm-pack` (`cargo install wasm-pack`)

## One-time build

```bash
cd path/to/Nettprogg_vsc
npm install
npm run rust:release          # build the relay + signaling binaries
npm run build:wasm            # build the CRDT WebAssembly bundle
npm run compile               # compile the TS extension
```

## Run a host + guest session on a single machine

1. Open the project in VS Code and press `F5`. A new Extension Development
   Host window opens with LiveShare Lite installed.
2. In the dev host, open or create any text file.
3. Run **LiveShare Lite: Start Server** (confirm port 7071). The Rust relay
   binary launches in the background; status appears in the LiveShare Lite
   output channel.
4. Run **LiveShare Lite: Start Session**. Accept the random room id.
5. Open a *second* VS Code window on the same project and press `F5` to open
   another Extension Development Host.
6. In that second host, open or create a text file (any file is fine — the
   extension syncs the currently active document).
7. Run **LiveShare Lite: Join Session** and enter the same room id you saw in
   step 4, with `ws://127.0.0.1:7071` as the relay URL.
8. Start typing in either window. Edits propagate live; the peer count in the
   status bar updates.

## Run between two machines

1. Build everything on the host machine (steps above).
2. Open port 7071 in the host's firewall.
3. On the host, run **LiveShare Lite: Start Server**.
4. On the guest, run **LiveShare Lite: Join Session** with
   `ws://<HOST-IP>:7071` and the same room id.

## Tests

```bash
npm run rust:test     # cargo test for CRDT + servers
npm test              # vitest packaging test
```

## Debugging

- The **LiveShare Lite** output channel in VS Code shows transport events,
  applied operations, and child-process logs.
- **LiveShare Lite: Show Debug State** dumps the current CRDT state to the
  output channel.
- **LiveShare Lite: Force Shutdown** kills the local Rust server and clears
  the session.

## Common issues

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `LiveShare Lite CRDT WebAssembly module is not available` | `src/wasm/crdt/` not built | `npm run build:wasm` |
| `relay-server did not report a listening address` | Cargo not on PATH | Install Rust stable, restart VS Code |
| `Address already in use` | Another process on port 7071 | `Force Shutdown` or change the port |
| Edits don't propagate | Both peers in the same room? | Use the same room id; check status bar |
