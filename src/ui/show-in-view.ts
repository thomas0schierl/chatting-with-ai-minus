/**
 * Shows a spot in a note or canvas in the main area: the text range is
 * scrolled to and highlighted, canvas cards are selected and panned into
 * view. It uses Obsidian's own search-result navigation (the `match`
 * ephemeral state), so both edit and reading view behave natively (reading
 * view scrolls and flashes the line).
 *
 * The view opens where the note already is, else in one reused tab, so the
 * user's own tab never changes under them. Used for following the AI's
 * edits (`followEdits`) and by `open_document`.
 */
import { Platform, type App, type FileView, type TextFileView, type TFile, type WorkspaceLeaf } from "obsidian";
import type { ViewTarget } from "../types";

/** The tab the AI's edits are shown in, reused while it is open. */
let followLeaf: WorkspaceLeaf | null = null;

/**
 * Open `target` in the main area. `reveal`: bring it to the front even on a
 * phone, where that closes the chat (only when the user asked for it).
 * False when the file doesn't exist.
 */
export async function showInView(app: App, target: ViewTarget, { reveal = false } = {}): Promise<boolean> {
  const file = app.vault.getFileByPath(target.path);
  if (!file) return false;
  // Only our own tab becomes the follow tab: one the user has the note open
  // in is shown, never taken over for the next note.
  const shown = leafShowing(app, file);
  const leaf = shown ?? reusableLeaf(app);
  if (!shown) followLeaf = leaf;
  const eState = await matchState(app, file, target);
  if ((leaf.view as FileView | undefined)?.file?.path === file.path) {
    // An open note takes in the change a moment after the file is written,
    // which would drop a highlight set before: wait for the new text.
    if (eState) {
      await showsText(leaf, eState);
      leaf.setEphemeralState(eState);
    }
  } else {
    await leaf.openFile(file, { active: false, ...(eState ? { eState } : {}) });
  }
  // On a phone the chat covers the note: bringing it forward would close
  // the chat, so following leaves it behind (the user sees it on closing).
  if (reveal || !Platform.isMobile) await app.workspace.revealLeaf(leaf);
  return true;
}

/** Resolves once the note in `leaf` shows the match's text (at most about 1 s). */
async function showsText(leaf: WorkspaceLeaf, eState: Record<string, unknown>): Promise<void> {
  const match = eState.match as { content?: string } | undefined;
  const view = leaf.view as Partial<TextFileView> | undefined;
  if (!match?.content || typeof view?.getViewData !== "function") return;
  for (let i = 0; i < 20 && view.getViewData() !== match.content; i++) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}

/** A main-area tab that already shows the file. */
function leafShowing(app: App, file: TFile): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateRootLeaves((leaf) => {
    if (!found && (leaf.view as FileView | undefined)?.file?.path === file.path) found = leaf;
  });
  return found;
}

/** The follow tab if it is still open in the main area, else a new tab. */
function reusableLeaf(app: App): WorkspaceLeaf {
  let open = false;
  app.workspace.iterateRootLeaves((leaf) => {
    if (leaf === followLeaf) open = true;
  });
  return open && followLeaf ? followLeaf : app.workspace.getLeaf("tab");
}

/** Obsidian's search-result state for the spot; undefined when there is none. */
async function matchState(app: App, file: TFile, target: ViewTarget): Promise<Record<string, unknown> | undefined> {
  if (file.extension === "canvas") {
    const node = target.nodes?.[0];
    return node ? { match: { nodeId: node, content: "", matches: [] } } : undefined;
  }
  if (target.from === undefined) return undefined;
  const content = await app.vault.cachedRead(file);
  const [from, to] = visibleRange(content, target.from, target.to ?? target.from);
  return { match: { content, matches: [[from, to]] } };
}

/** The range, or for an empty one (a deletion) the line it is on. */
export function visibleRange(content: string, from: number, to: number): [number, number] {
  const start = Math.max(0, Math.min(from, content.length));
  const end = Math.max(start, Math.min(to, content.length));
  if (end > start) return [start, end];
  const lineStart = content.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = content.indexOf("\n", start);
  return [lineStart, lineEnd === -1 ? content.length : lineEnd];
}

/**
 * The part of a text that changed, as a range in the new text: the text
 * between the unchanged start and end. Null when nothing changed.
 */
export function changedRange(before: string, after: string): { from: number; to: number } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: start, to: after.length - end };
}
