# TD-008: Only one conversation

There is a single chat; starting a new topic means clearing the old one
for good.

- **Where:** chat state in `src/main.ts`, `src/ui/ChatContainer.svelte`,
  `src/ui/chat-view.ts`
- **Impact:** medium (feature gap)

## Problem

Pressing Clear discards the conversation; there is no list of past
conversations to return to.

## Fix

- Named conversations: create, switch, rename and delete from a history
  list, with the title taken from the first message until renamed.
- Restore the last active conversation on startup.
- Migrate the existing `chat-state.json` into the first conversation, as a
  one-time, versioned migration (see the rules in `AGENTS.md`).
- Fix TD-007 first; with many conversations, a wipe loses much more.
- Reference implementation: the fork
  [nagisa525/obsidian-chatting-plus](https://github.com/nagisa525/obsidian-chatting-plus)
  (`ConversationRecord`, `chat-state.json` version 2).
