import dataChannel from "node-datachannel";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TextCrdt } from "../src/crdt/textCrdt";
import { CrdtOperation } from "../src/crdt/types";
import { SignalingServer } from "../src/server/signalingServer";
import { P2PMeshTransport } from "../src/transport/p2pMeshTransport";
import { TransportJoinedEvent, TransportOperationEvent, TransportSnapshotEvent } from "../src/transport/types";

describe("P2PMeshTransport", () => {
  let server: SignalingServer | undefined;
  let clients: MeshClient[] = [];

  afterEach(async () => {
    for (const client of clients) {
      client.close();
    }
    clients = [];
    await server?.stop();
    server = undefined;
  });

  afterAll(() => {
    dataChannel.cleanup();
  });

  it("converges across three peers with snapshot late join and duplicate forwarding", async () => {
    server = new SignalingServer({ port: 0, host: "127.0.0.1" });
    const port = await server.start();
    const signalingUrl = `ws://127.0.0.1:${port}`;

    const a = addClient(new MeshClient("A", signalingUrl, "seed"));
    a.connect();
    await waitFor(() => a.syncReady && a.text() === "seed");

    const b = addClient(new MeshClient("B", signalingUrl));
    b.connect();
    await waitFor(() => b.syncReady && a.connectedPeerIds().includes("B") && b.text() === "seed");

    a.insert(a.crdt.visibleLength(), "A");
    b.insert(0, "B");
    await waitFor(() => a.text() === b.text() && a.text().includes("A") && a.text().includes("B"));

    const c = addClient(new MeshClient("C", signalingUrl));
    c.connect();
    await waitFor(
      () =>
        c.syncReady &&
        c.text() === a.text() &&
        a.connectedPeerIds().includes("C") &&
        b.connectedPeerIds().includes("C") &&
        c.connectedPeerIds().length === 2
    );

    const [duplicate] = a.insert(a.crdt.visibleLength(), "!");
    a.transport.sendOperation(duplicate);
    await waitFor(() => sameText(a, b, c) && a.text().endsWith("!"));

    b.close();
    await waitFor(() => !a.presentPeerIds.includes("B") && !c.presentPeerIds.includes("B"));
    expect(sameText(a, c)).toBe(true);
  });

  function addClient(client: MeshClient): MeshClient {
    clients.push(client);
    return client;
  }
});

class MeshClient {
  crdt: TextCrdt;
  readonly transport: P2PMeshTransport;
  syncReady = false;
  presentPeerIds: string[] = [];
  private pendingOperations: TransportOperationEvent[] = [];
  private snapshotProviderPeerId?: string;
  private snapshotRequested = false;

  constructor(
    readonly clientId: string,
    signalingUrl: string,
    private readonly seedText = ""
  ) {
    this.crdt = new TextCrdt(clientId);
    this.transport = new P2PMeshTransport({
      signalingUrl,
      roomId: "mesh",
      clientId,
      iceServers: [],
      handlers: {
        onJoined: (event) => this.handleJoined(event),
        onPresence: (peers) => {
          this.presentPeerIds = peers.map((peer) => peer.clientId).sort((a, b) => a.localeCompare(b));
        },
        onOperation: (event) => this.handleOperation(event),
        onSnapshotRequest: (requestingClientId) => this.handleSnapshotRequest(requestingClientId),
        onSnapshot: (event) => this.handleSnapshot(event),
        onPeerChannelOpen: () => this.requestSnapshotIfNeeded(),
        onError: (message) => {
          throw new Error(message);
        }
      }
    });
  }

  connect(): void {
    this.transport.connect();
  }

  close(): void {
    this.transport.close();
  }

  text(): string {
    return this.crdt.toString();
  }

  connectedPeerIds(): string[] {
    return this.transport.connectedPeerIds();
  }

  insert(index: number, text: string): CrdtOperation[] {
    const ops = this.crdt.insert(index, text);
    for (const op of ops) {
      this.transport.sendOperation(op);
    }
    return ops;
  }

  private async handleJoined(event: TransportJoinedEvent): Promise<void> {
    this.presentPeerIds = event.peers.map((peer) => peer.clientId).sort((a, b) => a.localeCompare(b));

    if (event.existingPeerIds.length === 0) {
      if (this.seedText.length > 0) {
        this.insert(0, this.seedText);
      }
      this.syncReady = true;
      return;
    }

    this.snapshotProviderPeerId = event.existingPeerIds[0];
    this.requestSnapshotIfNeeded();
  }

  private async handleOperation(event: TransportOperationEvent): Promise<void> {
    if (!this.syncReady) {
      this.pendingOperations.push(event);
      return;
    }

    const alreadySeen = this.crdt.hasSeen(event.op);
    this.crdt.applyOperation(event.op);
    if (!alreadySeen) {
      this.transport.sendOperation(event.op, event.sourceClientId);
    }
  }

  private handleSnapshotRequest(clientId: string): void {
    if (this.syncReady) {
      this.transport.sendSnapshot(clientId, this.crdt.snapshot());
    }
  }

  private async handleSnapshot(event: TransportSnapshotEvent): Promise<void> {
    if (this.syncReady) {
      return;
    }

    this.crdt = TextCrdt.fromSnapshot(event.snapshot, this.clientId);
    this.syncReady = true;

    const queued = this.pendingOperations;
    this.pendingOperations = [];
    for (const operationEvent of queued) {
      await this.handleOperation(operationEvent);
    }
  }

  private requestSnapshotIfNeeded(): void {
    if (this.syncReady || this.snapshotRequested || !this.snapshotProviderPeerId) {
      return;
    }

    this.snapshotRequested = this.transport.requestSnapshot(this.snapshotProviderPeerId);
  }
}

function sameText(...clients: MeshClient[]): boolean {
  return new Set(clients.map((client) => client.text())).size === 1;
}

async function waitFor(predicate: () => boolean, timeoutMs = 7_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for condition.");
}
