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
assumes the provider APIs reject cross-origin requests. Two of them may
not:

- **Anthropic:** accepts browser requests when the request carries the
  header `anthropic-dangerous-direct-browser-access: true`.
- **OpenAI:** the OpenAI API also answers cross-origin requests; its SDKs
  allow browser use behind an explicit flag.
- **Codex backend:** browser access to `chatgpt.com/backend-api` is
  unlikely to be allowed.

**Unverified:** whether streaming `fetch` to those APIs works from
Obsidian's mobile WebViews and from desktop.

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
