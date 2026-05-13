import type * as vscode from "vscode";
import { TextCrdt } from "../crdt/textCrdt";
import { CrdtOperation } from "../crdt/types";

export type TextDocumentContentChangeLike = {
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

export function changesToOperations(
  changes: readonly TextDocumentContentChangeLike[],
  crdt: TextCrdt
): CrdtOperation[] {
  const operations: CrdtOperation[] = [];
  const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);

  for (const change of sorted) {
    if (change.rangeLength > 0) {
      operations.push(...crdt.delete(change.rangeOffset, change.rangeLength));
    }

    if (change.text.length > 0) {
      operations.push(...crdt.insert(change.rangeOffset, change.text));
    }
  }

  return operations;
}

export async function replaceDocumentText(
  vscodeApi: typeof vscode,
  document: vscode.TextDocument,
  text: string
): Promise<boolean> {
  const edit = new vscodeApi.WorkspaceEdit();
  const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
  const fullRange = new vscodeApi.Range(new vscodeApi.Position(0, 0), lastLine.range.end);
  edit.replace(document.uri, fullRange, text);
  return vscodeApi.workspace.applyEdit(edit);
}
