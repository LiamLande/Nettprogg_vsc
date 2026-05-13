import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

export function registerCommands(context: vscode.ExtensionContext, manager: SessionManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("liveshareLite.startServer", () => manager.startServer()),
    vscode.commands.registerCommand("liveshareLite.startSignalingServer", () => manager.startSignalingServer()),
    vscode.commands.registerCommand("liveshareLite.startSession", () => manager.startSession()),
    vscode.commands.registerCommand("liveshareLite.joinSession", () => manager.joinSession()),
    vscode.commands.registerCommand("liveshareLite.leaveSession", () => manager.leaveSession()),
    vscode.commands.registerCommand("liveshareLite.showDebugState", () => manager.showDebugState()),
    vscode.commands.registerCommand("liveshareLite.runLocalDemo", () => manager.runLocalDemo())
  );
}
