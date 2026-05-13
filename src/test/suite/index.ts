import * as assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("local.liveshare-lite");
  assert.ok(extension, "Extension local.liveshare-lite should be discoverable.");

  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "liveshareLite.startServer",
    "liveshareLite.startSession",
    "liveshareLite.joinSession",
    "liveshareLite.leaveSession",
    "liveshareLite.showDebugState",
    "liveshareLite.runLocalDemo"
  ]) {
    assert.ok(commands.includes(command), `Command ${command} should be registered.`);
  }
}
