# Tests

> **Belongs here:** how to run the offline tests and the live Codex scripts,
> and what each proves. **Elsewhere:** which quality scenarios need checking
> before a release (→ [arc42 §10](../docs/arc42/10-quality-requirements.md)).

## Offline regression tests

```bash
npm test
```

Bundles the real provider adapters and agent loop with an in-memory vault
and a mocked `requestUrl()`. No credentials or network needed. They cover
history encoding and replay per provider, tool flows, cancellation, model
catalogs and caching, and thinking parameters. They don't prove live-service
or mobile behaviour.

## Live Codex scripts

Talk to the real ChatGPT/Codex backend from Node, without Obsidian.

```bash
node test/codex-login.mjs                   # once: device-code login, saves temp/codex-token.json
node test/codex-smoke.mjs                   # one request (default model and message)
node test/codex-smoke.mjs gpt-5.5 "hi" --tools        # also send a function tool
node test/codex-smoke.mjs gpt-5.5 "hi" --web-search   # also enable web search
node test/codex-multi-turn.mjs              # function call and its result, over two turns
node test/codex-debug.mjs                   # print every raw SSE event
```

- `temp/` is git-ignored; the token never leaves the machine.
- The scripts build their requests by hand. A pass shows that request shape
  works for that account today, not that the plugin's code is correct;
  that's what `npm test` is for.
