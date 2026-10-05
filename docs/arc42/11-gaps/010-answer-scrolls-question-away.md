# GAP-010: New answers scroll the question out of view

Every new message jumps to the bottom of the chat, so long answers are
read from their end.

- **Where:** message scrolling in `src/ui/ChatContainer.svelte`
- **Impact:** medium on phones. Verify on a device before fixing.

## Problem

New messages set `scrollTop = scrollHeight`. On a phone, the start of a
long answer and the user's question end up off-screen.

## Fix

- After sending and when the answer arrives, scroll so the user's last
  question is at the top and the answer reads downward from it.
- Add temporary bottom padding so that position is reachable for short
  answers.
- Check whether mobile needs `env(safe-area-inset-top)` padding.
- Reference implementation: `scrollToLastQuestion()` in
  [nagisa525/obsidian-chatting-plus](https://github.com/nagisa525/obsidian-chatting-plus).
