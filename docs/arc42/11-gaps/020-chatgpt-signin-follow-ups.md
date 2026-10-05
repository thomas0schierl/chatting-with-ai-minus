# GAP-020: ChatGPT sign-in follow-ups

The official sign-in (ADR-13) is implemented, but some cases from OpenAI's
guidance and from mobile use aren't handled yet.

- **Where:** `src/auth/chatgptOAuth.ts`, `src/auth/chatgptOAuthStore.ts`,
  `src/settings.ts`, `ui/ChatContainer.svelte`
- **Impact:** medium; most visible on phones

## Problem

- **Lost attempt on mobile:** the pending sign-in (PKCE verifier, state,
  port) is kept only in memory. If the phone kills Obsidian while the user
  is in the browser, pasting the address fails with "another sign-in
  attempt", and the user has to start over.
- **No account switch:** the registration is bound to one account; signing
  in with a different ChatGPT account is rejected.
- **No ID token signature check:** OpenAI's docs ask apps to verify the ID
  token against its JWKS. The plugin checks issuer, audience, expiry and
  nonce, but not the RS256 signature, because the crypto it needs may be
  missing on mobile. The token comes straight from the token endpoint over
  TLS.
- **No re-consent:** if the plan scope (`chatgpt.tokens.use.direct`) is
  declined, connecting is refused, with no path to ask again
  (`prompt=consent`).
- **Usage cues missing:** OpenAI's UI guidelines suggest a "Using ChatGPT
  plan" indicator, a welcome after the first sign-in, and a usage-limit
  dialog. The chat has none of them yet; settings has "Manage usage".
- **Revocation:** not retried. The old Codex-route refresh token from
  before ADR-13 is never revoked, only overwritten.

## Fix

1. **Save the pending attempt** in SecretStorage until it is used or 10
   minutes old.
2. **Account switch:** add a "Use another account" action that starts a
   fresh registration.
3. **Signature:** verify the ID token signature with `@noble` (pure JS,
   works on mobile) against the cached JWKS.
4. **Re-consent:** offer it when the plan scope is missing.
5. **Usage cues:** add the usage cues to the chat UI together with the
   other chat-app work (GAP-014/015).
6. **Revocation:** retry it once; drop the old Codex credential on first
   load.
