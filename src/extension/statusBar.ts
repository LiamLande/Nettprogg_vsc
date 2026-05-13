import * as vscode from "vscode";

export type ConnectionState = "idle" | "syncing" | "connected" | "disconnected";

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "liveshareLite.showDebugState";
    this.setState("idle");
    this.item.show();
  }

  setState(state: ConnectionState, roomId?: string, peerCount = 0): void {
    const room = roomId ? ` ${roomId}` : "";
    const peers = peerCount > 0 ? ` (${peerCount})` : "";

    if (state === "connected") {
      this.item.text = `$(radio-tower) LiveShare:${room}${peers}`;
      this.item.tooltip = "LiveShare Lite connected";
      return;
    }

    if (state === "syncing") {
      this.item.text = `$(sync~spin) LiveShare:${room}`;
      this.item.tooltip = "LiveShare Lite syncing";
      return;
    }

    if (state === "disconnected") {
      this.item.text = `$(debug-disconnect) LiveShare:${room}`;
      this.item.tooltip = "LiveShare Lite disconnected; local edits are queued";
      return;
    }

    this.item.text = "$(circle-outline) LiveShare";
    this.item.tooltip = "LiveShare Lite idle";
  }

  dispose(): void {
    this.item.dispose();
  }
}
