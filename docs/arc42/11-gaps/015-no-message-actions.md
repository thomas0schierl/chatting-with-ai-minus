# GAP-015: No actions on single messages (copy, regenerate)

Chat apps let you copy one answer or ask for a new one; here the only
message-level control is copying the whole transcript via a command.

- **Where:** `ui/ChatContainer.svelte`, `ui/chat-view.ts`, `agent/loop.ts`
- **Impact:** medium (chat-app feel); small once GAP-014 exists

## Problem

- **Copy:** an answer can only be copied by selecting its rendered text.
  The *Copy transcript* command copies everything.
- **Regenerate:** an unsatisfying answer can't be regenerated, so users
  retype the question.

## Fix

- **Copy:** a copy action on each answer that copies its Markdown source,
  not the rendered HTML.
- **Regenerate:** an action on the last answer that rolls back to just
  before it (the cut from [GAP-014](014-edit-message-and-continue.md)) and
  runs the same user message again.
- **Placement:** keep the actions small and in one place, like the
  ChatGPT app's row under each answer. On mobile they must be reachable
  without hover.
