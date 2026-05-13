import * as vscode from "vscode";

export type ConnectionState = "idle" | "syncing" | "connected" | "disconnected";

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly stopItem: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "liveshareLite.showDebugState";
    this.stopItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.stopItem.command = "liveshareLite.forceShutdown";
    this.stopItem.text = "$(debug-stop) LiveShare";
    this.stopItem.tooltip = "Force shutdown LiveShare Lite";
    this.setState("idle");
    this.item.show();
  }

  setState(state: ConnectionState, roomId?: string, peerCount = 0): void {
    const room = roomId ? ` ${roomId}` : "";
    const peers = peerCount > 0 ? ` (${peerCount})` : "";

    if (state === "connected") {
      this.item.text = `$(radio-tower) LiveShare:${room}${peers}`;
      this.item.tooltip = "LiveShare Lite connected";
      this.stopItem.show();
      return;
    }

    if (state === "syncing") {
      this.item.text = `$(sync~spin) LiveShare:${room}`;
      this.item.tooltip = "LiveShare Lite syncing";
      this.stopItem.show();
      return;
    }

    if (state === "disconnected") {
      this.item.text = `$(debug-disconnect) LiveShare:${room}`;
      this.item.tooltip = "LiveShare Lite disconnected; local edits are queued";
      this.stopItem.show();
      return;
    }

    this.item.text = "$(circle-outline) LiveShare";
    this.item.tooltip = "LiveShare Lite idle";
    this.stopItem.hide();
  }

  dispose(): void {
    this.item.dispose();
    this.stopItem.dispose();
  }
}
