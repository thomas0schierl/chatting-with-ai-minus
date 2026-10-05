# GAP-007: Chat history can be wiped when the plugin unloads early

If the plugin unloads before it has read the saved conversation, it saves
an empty one over it.

- **Where:** `onunload()`, `saveChatHistory()`, `loadChatHistory()` in `src/main.ts`
- **Impact:** medium; the saved conversation is lost silently

## Problem

- `onunload()` always saves the in-memory history.
- That history starts empty and is only filled at the end of the async
  `onload()`.
- An unload before loading finishes overwrites `chat-state.json` with an
  empty history.

This was seen once during testing (2026-09-29), after a restart with the
Tray plugin, which hides Obsidian on startup. It was not reproduced, so the
cause is likely but unconfirmed.

## Fix

Set a flag when the history has been loaded, and skip saving until it is
set.
