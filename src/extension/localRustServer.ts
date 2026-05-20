import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type LocalRustServerKind = "relay" | "signaling";

export type LocalRustServerOptions = {
  kind: LocalRustServerKind;
  port: number;
  host: string;
  /**
   * Filesystem location of the project root (the folder containing
   * `package.json` and `crates/`). Used to locate the Rust binary and to
   * compute the cargo manifest path for the fallback `cargo run` launcher.
   */
  projectRoot: string;
  /**
   * Optional callback used to surface child-process logs (stdout/stderr) to
   * the extension's output channel.
   */
  log?(message: string): void;
};

const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Launches one of the Rust workspace binaries (`relay-server` or
 * `signaling-server`) as a child process and exposes the same lifecycle
 * surface (`start`, `stop`, `port`) the extension used to call against the
 * old in-process TypeScript servers.
 *
 * Preference order:
 *
 * 1. The release binary at `crates/target/release/<kind>-server[.exe]`.
 * 2. `cargo run --release --manifest-path crates/Cargo.toml --bin <kind>-server`.
 *
 * The latter is slower on first run because cargo has to compile, but it
 * means a freshly cloned checkout can host a session without an extra build
 * step. Once the user has run `npm run rust:release` the prebuilt binary is
 * used instead.
 */
export class LocalRustServer {
  private child?: ChildProcess;
  private actualPort?: number;

  constructor(private readonly options: LocalRustServerOptions) {}

  async start(): Promise<number> {
    if (this.child) {
      return this.actualPort ?? this.options.port;
    }

    const command = this.resolveCommand();
    const env = {
      ...process.env,
      PORT: String(this.options.port),
      HOST: this.options.host,
      RUST_LOG: process.env.RUST_LOG ?? "info"
    };

    this.options.log?.(`Spawning ${command.cmd} ${command.args.join(" ")}`);
    const child = spawn(command.cmd, command.args, {
      cwd: this.options.projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    this.child = child;

    return new Promise<number>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stop().catch(() => undefined);
          reject(
            new Error(
              `${this.options.kind}-server did not report a listening address within ${STARTUP_TIMEOUT_MS}ms.`
            )
          );
        }
      }, STARTUP_TIMEOUT_MS);

      const onLine = (line: string, source: "stdout" | "stderr") => {
        const trimmed = line.trim();
        if (trimmed) {
          this.options.log?.(`[${this.options.kind}:${source}] ${trimmed}`);
        }
        const match = trimmed.match(/listening on ws:\/\/[^:]+:(\d+)/i);
        if (match && !resolved) {
          this.actualPort = parseInt(match[1], 10);
          resolved = true;
          clearTimeout(timeout);
          resolve(this.actualPort);
        }
      };

      attachLineListener(child, "stdout", (line) => onLine(line, "stdout"));
      attachLineListener(child, "stderr", (line) => onLine(line, "stderr"));

      child.on("error", (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on("exit", (code, signal) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(
            new Error(
              `${this.options.kind}-server exited before reporting a port (code=${code}, signal=${signal ?? "none"}).`
            )
          );
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.actualPort = undefined;
    if (!child) {
      return;
    }
    return new Promise((resolve) => {
      // If the child has already exited, resolve immediately.
      if (child.exitCode != null || child.killed) {
        resolve();
        return;
      }

      // Track resolution and provide a safety timeout in case signals don't trigger.
      const resolvedRef = { resolved: false } as { resolved: boolean };
      const timeout = setTimeout(() => {
        finish();
      }, 2000);

      const finish = () => {
        if (!resolvedRef.resolved) {
          resolvedRef.resolved = true;
          clearTimeout(timeout);
          resolve();
        }
      };

      child.once("exit", finish);
      child.once("close", finish);

      try {
        if (process.platform === "win32") {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }, 1500);
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        finish();
      }
    });
  }

  port(): number {
    return this.actualPort ?? this.options.port;
  }

  /** Decide whether to use a prebuilt binary or fall back to cargo run. */
  private resolveCommand(): { cmd: string; args: string[] } {
    const binary = this.findPrebuiltBinary();
    if (binary) {
      return { cmd: binary, args: [] };
    }

    const manifestPath = path.join(this.options.projectRoot, "crates", "Cargo.toml");
    return {
      cmd: "cargo",
      args: [
        "run",
        "--release",
        "--quiet",
        "--manifest-path",
        manifestPath,
        "--bin",
        `${this.options.kind}-server`
      ]
    };
  }

  private findPrebuiltBinary(): string | undefined {
    const exe = process.platform === "win32" ? ".exe" : "";
    const candidates = [
      path.join(this.options.projectRoot, "crates", "target", "release", `${this.options.kind}-server${exe}`),
      path.join(this.options.projectRoot, "crates", "target", "debug", `${this.options.kind}-server${exe}`),
      path.join(this.options.projectRoot, "target", "release", `${this.options.kind}-server${exe}`),
      path.join(this.options.projectRoot, "target", "debug", `${this.options.kind}-server${exe}`)
    ];
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // try the next candidate
      }
    }
    return undefined;
  }
}

function attachLineListener(
  child: ChildProcess,
  source: "stdout" | "stderr",
  onLine: (line: string) => void
): void {
  const stream = source === "stdout" ? child.stdout : child.stderr;
  if (!stream) {
    return;
  }
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line.replace(/\r$/, ""));
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = "";
    }
  });
}
