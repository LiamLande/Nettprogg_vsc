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

export function applyTextChanges(text: string, changes: readonly TextDocumentContentChangeLike[]): string {
  let nextText = text;
  const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);

  for (const change of sorted) {
    const start = change.rangeOffset;
    const end = change.rangeOffset + change.rangeLength;
    if (start < 0 || end < start || end > nextText.length) {
      throw new RangeError(`Change range ${start}:${change.rangeLength} is outside document length ${nextText.length}.`);
    }

    nextText = `${nextText.slice(0, start)}${change.text}${nextText.slice(end)}`;
  }

  return nextText;
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
