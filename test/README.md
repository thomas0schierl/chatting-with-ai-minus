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
vault and a mocked `requestUrl()`; new test files import from it. No
credentials or network needed. They cover
history encoding and replay per provider, tool flows, cancellation, model
catalogs and caching, thinking parameters, and the ChatGPT sign-in
(`chatgpt-signin.test.mjs`). They don't prove live-service or mobile
behaviour.

## Live checks

Live provider behaviour (sign-in, chat, model lists) is checked in
Obsidian itself, on desktop and on a phone.
