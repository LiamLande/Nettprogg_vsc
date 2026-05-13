# Demo Script

## Demo 1: Basic Real-Time Editing

1. Run `npm run compile`.
2. Open Extension Development Host.
3. Run `LiveShare Lite: Start Server`.
4. In window A, run `LiveShare Lite: Start Session` and use room `abc123`.
5. In window B, run `LiveShare Lite: Join Session` and use the same room.
6. Type in one window and show the other window updating.

## Demo 2: Concurrent Edits

1. Start both clients with the same content.
2. Disconnect one client by stopping the relay or network.
3. Edit both clients near the same position.
4. Reconnect and show that both documents converge.

## Demo 3: Test Evidence

Run:

```bash
npm test
```

Highlight the CRDT unit tests, convergence tests, randomized network simulation and relay server test.

## Demo 4: Benchmark

Run:

```bash
npm run bench
```

Use the 100, 1,000 and 10,000 character numbers to discuss tombstones and future optimization.
