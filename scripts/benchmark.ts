import { performance } from "node:perf_hooks";
import { TextCrdt } from "../src/crdt/textCrdt";

const sizes = [100, 1_000, 10_000];

for (const size of sizes) {
  const crdt = new TextCrdt(`bench-${size}`);
  const text = "x".repeat(size);
  const start = performance.now();
  crdt.insert(0, text);
  const rendered = crdt.toString();
  const elapsedMs = performance.now() - start;
  const memoryMb = process.memoryUsage().heapUsed / 1024 / 1024;

  console.log(
    JSON.stringify({
      size,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      memoryMb: Number(memoryMb.toFixed(2)),
      ok: rendered.length === size
    })
  );
}
