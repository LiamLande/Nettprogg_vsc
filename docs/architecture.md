# Architecture

LiveShare Lite is intentionally narrow: one active text document and a CRDT replica in every client.

```text
VS Code client A  ── operation messages ──┐
                                          │
VS Code client B  ── operation messages ──┼── WebSocket relay
                                          │
VS Code client C  ── operation messages ──┘
```

Relay mode uses a WebSocket server that does not resolve conflicts. It keeps room membership, stores an operation log in memory and broadcasts messages. Every VS Code extension instance owns a `TextCrdt` replica and applies both local and remote operations.

P2P mode replaces the operation relay with a small WebRTC mesh:

```text
VS Code client A ───── DataChannel CRDT ops/snapshots ───── VS Code client B
       │                         │                                  │
       └──── WebSocket signaling: join, presence, offers, ICE ──────┘
```

The signaling server stores only active room membership and forwards WebRTC signaling payloads. Document text, CRDT operations and CRDT snapshots move over peer-to-peer DataChannels.

## Client Flow

1. The extension joins a room.
2. The server sends the room operation log.
3. The client applies the log locally.
4. Local VS Code edits are translated into CRDT insert/delete operations.
5. Remote operations are applied to the local CRDT and rendered back into the document with `WorkspaceEdit`.

The extension uses an `applyingRemoteChange` guard to avoid interpreting its own remote render as a new local edit.

## Reconnect

If the WebSocket disconnects, local edits continue to update the local CRDT and are queued. On reconnect, the client rejoins the same room, applies the server operation log idempotently and flushes queued operations.

## P2P Join Flow

1. The extension joins a signaling room.
2. Existing peers are introduced by the signaling server.
3. Each peer pair uses a deterministic rule: the lower client ID creates the DataChannel and offer.
4. The first peer in an empty room seeds its CRDT from the active document.
5. A later peer requests one CRDT snapshot from the lowest existing peer ID and applies live operations after the snapshot.
6. Newly observed operations are forwarded to other mesh peers; duplicate operation IDs remain idempotent.
