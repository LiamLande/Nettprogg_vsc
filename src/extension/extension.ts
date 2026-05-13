import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { SessionManager } from "./sessionManager";

let manager: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  manager = new SessionManager(context);
  registerCommands(context, manager);
}

export function deactivate(): void {
  manager?.dispose();
  manager = undefined;
}
