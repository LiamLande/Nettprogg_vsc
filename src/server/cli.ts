import { RelayServer } from "./relayServer";
import { SignalingServer } from "./signalingServer";

async function main(): Promise<void> {
  const mode = process.argv[2] === "signaling" ? "signaling" : "relay";
  const portArg = mode === "signaling" ? process.argv[3] : process.argv[3] ?? process.argv[2];
  const defaultPort = mode === "signaling" ? 7072 : 7071;
  const port = Number(process.env.PORT ?? portArg ?? defaultPort);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = mode === "signaling" ? new SignalingServer({ port, host }) : new RelayServer({ port, host });
  const actualPort = await server.start();

  console.log(`LiveShare Lite ${mode} server listening on ws://${host}:${actualPort}`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
