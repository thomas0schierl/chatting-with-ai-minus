# GAP-020: ChatGPT sign-in follow-ups

The official sign-in (ADR-13) is implemented, but some cases from OpenAI's
guidance and from mobile use aren't handled yet.

- **Where:** `src/auth/chatgptOAuth.ts`, `src/auth/chatgptOAuthStore.ts`,
  `src/settings.ts`, `ui/ChatContainer.svelte`
- **Impact:** medium; most visible on phones

## Problem

- **No account switch:** the registration is bound to one account; signing
  in with a different ChatGPT account is rejected.
- **No re-consent:** if the plan scope (`chatgpt.tokens.use.direct`) is
  declined, connecting is refused, with no path to ask again
  (`prompt=consent`).
- **Usage cues missing:** OpenAI's UI guidelines suggest a "Using ChatGPT
  plan" indicator, a welcome after the first sign-in, and a usage-limit
  dialog. The chat has none of them yet; settings has "Manage usage".

## Fix

1. **Account switch:** add a "Use another account" action that starts a
   fresh registration.
2. **Re-consent:** offer it when the plan scope is missing.
3. **Usage cues:** add the usage cues to the chat UI together with the
   other chat-app work (GAP-014/015).
