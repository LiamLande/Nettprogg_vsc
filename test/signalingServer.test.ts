import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { SignalingServer } from "../src/server/signalingServer";
import { SignalingServerMessage } from "../src/shared/signalingMessages";

describe("SignalingServer", () => {
  let server: SignalingServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("tracks room presence as peers join and leave", async () => {
    server = new SignalingServer({ port: 0, host: "127.0.0.1" });
    const port = await server.start();
    const url = `ws://127.0.0.1:${port}`;

    const a = await connect(url);
    a.send(JSON.stringify({ type: "join", roomId: "mesh", clientId: "A" }));
    const joinedA = await waitForType(a, "joined");
    expect(joinedA.peers.map((peer) => peer.clientId)).toEqual(["A"]);

    const b = await connect(url);
    b.send(JSON.stringify({ type: "join", roomId: "mesh", clientId: "B" }));
    const joinedB = await waitForType(b, "joined");
    const peerJoined = await waitForType(a, "peerJoined");

    expect(joinedB.peers.map((peer) => peer.clientId)).toEqual(["A", "B"]);
    expect(peerJoined.peer.clientId).toBe("B");
    expect(peerJoined.peers.map((peer) => peer.clientId)).toEqual(["A", "B"]);

    b.close();
    const peerLeft = await waitForType(a, "peerLeft");
    expect(peerLeft.clientId).toBe("B");
    expect(peerLeft.peers.map((peer) => peer.clientId)).toEqual(["A"]);

    a.close();
  });

  it("forwards directed signaling payloads without storing document data", async () => {
    server = new SignalingServer({ port: 0, host: "127.0.0.1" });
    const port = await server.start();
    const url = `ws://127.0.0.1:${port}`;

    const a = await connect(url);
    const b = await connect(url);
    a.send(JSON.stringify({ type: "join", roomId: "mesh", clientId: "A" }));
    b.send(JSON.stringify({ type: "join", roomId: "mesh", clientId: "B" }));
    await waitForType(a, "joined");
    await waitForType(b, "joined");

    a.send(
      JSON.stringify({
        type: "signal",
        roomId: "mesh",
        clientId: "A",
        targetClientId: "B",
        signal: {
          type: "description",
          descriptionType: "offer",
          sdp: "fake-sdp"
        }
      })
    );

    const forwarded = await waitForType(b, "signal");
    expect(forwarded.clientId).toBe("A");
    expect(forwarded.targetClientId).toBe("B");
    expect(forwarded.signal).toEqual({
      type: "description",
      descriptionType: "offer",
      sdp: "fake-sdp"
    });

    a.close();
    b.close();
  });
});

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function waitForType<TType extends SignalingServerMessage["type"]>(
  socket: WebSocket,
  type: TType
): Promise<Extract<SignalingServerMessage, { type: TType }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as SignalingServerMessage;
      if (message.type === type) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message as Extract<SignalingServerMessage, { type: TType }>);
      }
    };

    socket.on("message", onMessage);
  });
}
