# GAP-014: Can't edit an earlier message and continue from there

In the ChatGPT and Claude apps you can edit one of your earlier messages;
the conversation rolls back to that point and continues with the edited
text. Here messages can't be changed at all.

- **Where:** `ui/ChatContainer.svelte` (message actions), `ui/chat-view.ts`,
  `agent/loop.ts` (history), chat history in `main.ts`
- **Impact:** high (core chat-app feel); medium effort

## Problem

- User messages have no actions; the only way to change course is to send
  a correction or clear everything.
- The UI history (`plugin.chatHistory`) and the API history
  (`AgentLoop.messages`, which also holds tool calls and results) are
  separate lists with no link between them. There is no way to find "the
  point before this message" in both.

## Fix

1. **Turn IDs:** give each user turn an ID stored on its UI entries and its
   API messages, so both histories can be cut at the same point.
2. **Edit:** an edit action on each user message (visible on hover on
   desktop, always visible or on long-press on mobile) opens the text in
   place, with its images and selection scope kept.
3. **Submit:**
   - Stop a running turn.
   - Cut both histories to just before that turn and save.
   - Run the edited message as a new turn.
   - **Providers:** a cut history means a new message list, so OpenAI
     falls back to full replay and drops its `previous_response_id` chain.
     That is existing behaviour; check it with a test.
4. **Vault changes aren't rolled back.** Notes the AI created or edited
   after that point stay as they are. Say so once in the edit UI.
   Undoing tool effects is out of scope.
5. **No branches:** the discarded continuation is gone; there's no
   "< 2/2 >" switcher. Revisit together with
   [GAP-008](008-single-conversation-only.md).
6. **Regenerate uses the same cut**
   ([GAP-015](015-no-message-actions.md)).
7. **Tests:**
   - Cut at the first, a middle and the last turn.
   - Cut inside a turn with tool calls.
   - Saved state after a cut.
   - Each provider's request after a cut.
