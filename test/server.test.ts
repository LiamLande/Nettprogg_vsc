import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { TextCrdt } from "../src/crdt/textCrdt";
import { RelayServer } from "../src/server/relayServer";
import { ServerMessage } from "../src/shared/messages";

describe("RelayServer", () => {
  let server: RelayServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("relays operations and replays room log to late joiners", async () => {
    server = new RelayServer({ port: 0, host: "127.0.0.1" });
    const port = await server.start();
    const url = `ws://127.0.0.1:${port}`;

    const a = await connect(url);
    a.send(JSON.stringify({ type: "join", roomId: "abc123", clientId: "A" }));
    await waitForType(a, "joined");

    const crdt = new TextCrdt("A");
    const [op] = crdt.insert(0, "x");
    a.send(JSON.stringify({ type: "operation", roomId: "abc123", clientId: "A", op }));
    const echoed = await waitForType(a, "operation");
    expect(echoed.type).toBe("operation");

    const b = await connect(url);
    b.send(JSON.stringify({ type: "join", roomId: "abc123", clientId: "B" }));
    const joined = await waitForType(b, "joined");

    expect(joined.type).toBe("joined");
    if (joined.type === "joined") {
      expect(joined.opLog).toHaveLength(1);
      expect(joined.opLog[0]).toEqual(op);
    }

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

async function waitForType<TType extends ServerMessage["type"]>(
  socket: WebSocket,
  type: TType
): Promise<Extract<ServerMessage, { type: TType }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === type) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message as Extract<ServerMessage, { type: TType }>);
      }
    };

    socket.on("message", onMessage);
  });
}
