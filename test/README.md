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
provider, tool flows, cancellation, model catalogs and caching, thinking
parameters, the ChatGPT sign-in (`chatgpt-signin.test.mjs`), canvas tools
(`canvas.test.mjs`), image tools and canvas drawing (`view-tools.test.mjs`),
math conversion (`math-markdown.test.mjs`), streamed answers: SSE
parsing, rebuilt responses, fallback, Stop and rate-limit retry
(`streaming.test.mjs`), and editing a message, regenerating and copying
an answer through the chat view with a fake Svelte component
(`message-actions.test.mjs`), saving each image once with the
migration of older saved chats (`images-once.test.mjs`), and named
conversations: migration, new chat, switch, rename, delete, restore,
titles, and isolation of histories and OpenAI chaining
(`conversations.test.mjs`). They don't prove live-service or mobile behaviour.

## Live checks

Live provider behaviour (sign-in, chat, model lists) is checked in
Obsidian itself, on desktop and on a phone.
