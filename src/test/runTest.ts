import * as path from "node:path";
import { spawn } from "node:child_process";
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: "1.100.0" });
  const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

  await runCli(cliPath, [
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensions-dir=${path.resolve(extensionDevelopmentPath, ".vscode-test/extensions")}`,
    `--user-data-dir=${path.resolve(extensionDevelopmentPath, ".vscode-test/user-data")}`
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function runCli(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`VS Code extension host exited with ${code ?? signal}.`));
    });
  });
}
