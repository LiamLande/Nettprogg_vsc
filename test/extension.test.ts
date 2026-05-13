import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TextCrdt } from "../src/crdt/textCrdt";
import { changesToOperations } from "../src/extension/documentAdapter";

describe("extension packaging", () => {
  it("contributes the expected VS Code commands", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const commands = packageJson.contributes.commands.map((command) => command.command);

    expect(commands).toContain("liveshareLite.startServer");
    expect(commands).toContain("liveshareLite.startSession");
    expect(commands).toContain("liveshareLite.joinSession");
    expect(commands).toContain("liveshareLite.leaveSession");
    expect(commands).toContain("liveshareLite.showDebugState");
  });

  it("translates local text document changes into CRDT operations", () => {
    const crdt = new TextCrdt("A");
    crdt.insert(0, "abc");

    const ops = changesToOperations([{ rangeOffset: 1, rangeLength: 1, text: "X" }], crdt);

    expect(ops.map((op) => op.type)).toEqual(["delete", "insert"]);
    expect(crdt.toString()).toBe("aXc");
  });
});
