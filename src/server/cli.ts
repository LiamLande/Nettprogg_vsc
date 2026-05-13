import { RelayServer } from "./relayServer";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 7071);
  const server = new RelayServer({ port, host: "127.0.0.1" });
  const actualPort = await server.start();

  console.log(`LiveShare Lite relay server listening on ws://127.0.0.1:${actualPort}`);

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
