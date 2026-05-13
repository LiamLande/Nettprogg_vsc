# Architecture

LiveShare Lite is intentionally narrow: one active text document, one WebSocket room and a CRDT replica in every client.

```text
VS Code client A  ── operation messages ──┐
                                          │
VS Code client B  ── operation messages ──┼── WebSocket relay
                                          │
VS Code client C  ── operation messages ──┘
```

The relay server does not resolve conflicts. It keeps room membership, stores an operation log in memory and broadcasts messages. Every VS Code extension instance owns a `TextCrdt` replica and applies both local and remote operations.

## Client Flow

1. The extension joins a room.
2. The server sends the room operation log.
3. The client applies the log locally.
4. Local VS Code edits are translated into CRDT insert/delete operations.
5. Remote operations are applied to the local CRDT and rendered back into the document with `WorkspaceEdit`.

The extension uses an `applyingRemoteChange` guard to avoid interpreting its own remote render as a new local edit.

## Reconnect

If the WebSocket disconnects, local edits continue to update the local CRDT and are queued. On reconnect, the client rejoins the same room, applies the server operation log idempotently and flushes queued operations.
