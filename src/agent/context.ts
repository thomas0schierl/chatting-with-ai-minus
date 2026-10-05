import { App } from "obsidian";
import type { ConversationContext } from "../types";

/**
 * Builds a snapshot of the current workspace context.
 * Refreshed each turn; it goes into the user message (ADR-05). `voice`
 * marks a turn from a voice conversation, whose answer will be spoken.
 */
export function buildContext(app: App, voice = false): ConversationContext {
  const activeFile = app.workspace.getActiveFile();
  let activeFileContent: string | null = null;
  let selection: string | null = null;

  // Get selection from active editor
  const editor = app.workspace.activeEditor?.editor;
  if (editor) {
    const sel = editor.getSelection();
    if (sel && sel.length > 0) {
      selection = sel;
    }
  }

  return {
    activeFile: activeFile?.path ?? null,
    activeFileContent, // Populated lazily by the loop if needed
    selection,
    vaultName: app.vault.getName(),
    fileCount: app.vault.getMarkdownFiles().length,
    ...(voice ? { voice: true } : {}),
  };
}
