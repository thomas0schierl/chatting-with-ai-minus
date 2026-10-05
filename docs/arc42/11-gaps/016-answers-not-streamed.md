# GAP-016: Answers appear only when complete

Chat apps show the answer as it's written; here the user watches a
thinking indicator until the whole answer arrives.

- **Where:** `api/*.ts` adapters, `agent/loop.ts` callbacks,
  `ui/ChatContainer.svelte`; ADR-01
- **Impact:** high (biggest difference in feel for long answers); effort
  depends on the spike

## Problem

ADR-01 sends all HTTP through `requestUrl()`, which returns complete
responses only, because mobile WebViews enforce CORS on `fetch`. That
assumes the provider APIs reject cross-origin requests. Checked on
2026-10-05 against Obsidian's origins (`app://obsidian.md`,
`capacitor://localhost`, `http://localhost`), two of them don't:

- **Anthropic `/v1/messages`:** allows any origin when the request carries
  `anthropic-dangerous-direct-browser-access: true`; without the header it
  sends no CORS headers.
- **OpenAI `/v1/responses`:** allows any origin.
- **Codex `/backend-api/codex/responses`:** no allow-origin header; browsers
  block it.

**Still unverified:** that the Obsidian apps let a plugin `fetch` with a
streamed body. This needs a device test. Proposed decision:
[ADR-12](../09-architecture-decisions.md).

## Fix

1. **Spike** on desktop, iOS and Android: a streaming `fetch` to Anthropic
   (with the header above) and to OpenAI. Check:
   - CORS acceptance
   - that the body arrives incrementally
   - that Stop cancels it (`AbortController`)
2. **If it works:** a new ADR that lets the Anthropic and OpenAI adapters
   stream with `fetch`. The agent loop and UI then render text deltas as
   they arrive, and tool calls still run when complete.
3. **Codex:** stays buffered unless the spike shows otherwise. Show a
   clearer "writing…" state there.
4. **Stop:** with streaming, Stop can cancel the request itself, not just
   ignore its result.
5. **Keys in browser requests:** the API key travels in a header from the
   user's own device, as today. Note this in §8.
