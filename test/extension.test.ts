import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTextChanges } from "../src/extension/documentAdapter";

describe("extension packaging", () => {
  it("contributes the expected VS Code commands", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const commands = packageJson.contributes.commands.map((command) => command.command);

    expect(commands).toContain("liveshareLite.startServer");
    expect(commands).toContain("liveshareLite.startSignalingServer");
    expect(commands).toContain("liveshareLite.startSession");
    expect(commands).toContain("liveshareLite.joinSession");
    expect(commands).toContain("liveshareLite.leaveSession");
    expect(commands).toContain("liveshareLite.forceShutdown");
    expect(commands).toContain("liveshareLite.showDebugState");
  });

  it("applies multiple VS Code text changes from the original document offsets", () => {
    const nextText = applyTextChanges("abcdef", [
      { rangeOffset: 1, rangeLength: 2, text: "XX" },
      { rangeOffset: 5, rangeLength: 1, text: "Y" }
    ]);

    expect(nextText).toBe("aXXdeY");
  });
});
