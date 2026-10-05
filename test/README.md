# Tests

> **Belongs here:** how to run the offline tests and what they prove.
> **Elsewhere:** which quality scenarios need checking before a release
> (→ [arc42 §10](../docs/arc42/10-quality-requirements.md)).

## Offline regression tests

```bash
npm test
```

Runs every `test/*.test.mjs` (`scripts/test.mjs`). `test/harness.mjs`
bundles the real plugin modules with a fake Obsidian API, an in-memory
vault and a mocked `requestUrl()`; new test files import from it. Its
`fetch` fails like a CORS block unless a test sets `globalThis.__fetch`, so
chat requests take the `requestUrl()` fallback and receive SSE. No
credentials or network needed. They cover history encoding and replay per
provider (Anthropic web search in the documented stream shape), tool
flows, cancellation, model catalogs and caching, thinking
parameters, the ChatGPT sign-in and its refresh and retry after a 401
(`chatgpt-signin.test.mjs`), canvas tools
(`canvas.test.mjs`), image tools, leaving older tool images out of
requests, and canvas drawing (`view-tools.test.mjs`),
math conversion (`math-markdown.test.mjs`), streamed answers: SSE
parsing, rebuilt responses, fallback and when `fetch` is skipped, Stop
and the rate-limit retry (also Anthropic errors inside the stream)
(`streaming.test.mjs`), editing a message, regenerating and copying
an answer through the chat view with a fake Svelte component
(`message-actions.test.mjs`, also Stop and Clear while `ask_user`
waits), saving each image once with the
migration of older saved chats (`images-once.test.mjs`), named
conversations: migration, new chat, switch (the API history keeps up to 80
messages), rename, delete, restore, an
unreadable saved file kept aside, saves one at a time, tool card inputs after a reload,
titles, and isolation of histories and OpenAI chaining
(`conversations.test.mjs`), `edit_document` without content
(`edit-document.test.mjs`), and the ChatGPT plan cues: no retry on a
usage limit, its own message, the one-time welcome
(`chatgpt-usage.test.mjs`), and live voice with fake WebRTC, microphone
and audio (`voice.test.mjs`): session creation on both routes, both event
dialects, delegation through the chat view with progress, chunked
answers and a stopped older turn, hold to talk, ending, and the Codex
sign-in. The harness builds with `__CODEX_VOICE__` true;
`voice-build.test.mjs` runs the real build config and checks that the
public bundle has no Codex voice code. They don't prove live-service or mobile behaviour.

## Live checks

Live provider behaviour (sign-in, chat, model lists) is checked in
Obsidian itself, on desktop and on a phone.
