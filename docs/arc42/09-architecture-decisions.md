# 9. Architecture decisions

> **Belongs here:** decisions that are costly to reverse, each with its
> context, the decision and its consequences. Add new ones at the end and
> never rewrite old ones; mark them superseded instead. **Elsewhere:**
> limits we didn't choose (→ [2](02-constraints.md)).

## ADR-01: All HTTP through `requestUrl()`, no streaming

- **Context:** mobile WebViews enforce CORS, and `requestUrl()` is the only
  HTTP API that works on every platform. It returns complete responses only.
- **Decision:** every request uses `requestUrl()`. Answers appear when
  complete; streamed responses (Codex) are parsed from the buffered SSE text.
- **Consequences:** no token-by-token output; long answers show a thinking
  indicator until done.

## ADR-02: ChatGPT sign-in with the Device Authorization Flow

- **Context:** a browser-redirect login needs a localhost server, which
  mobile can't run.
- **Decision:** the user opens a verification URL in any browser and enters
  a code; the plugin polls for the token. Tokens refresh automatically.
- **Consequences:** works on all platforms; login takes one extra step.

## ADR-03: The Codex backend is driven like the Codex CLI

- **Context:** the ChatGPT/Codex backend only accepts requests shaped like
  its own CLI's. It requires `store: false` and `stream: true`, rejects
  unknown clients, and hides models newer than the reported client
  version.
- **Decision:**
  - Send the Codex CLI's `originator` and the latest stable Codex release
    as `client_version`.
  - Replay the full conversation every turn, since `store: false` rules out
    `previous_response_id`.
  - Parse the buffered SSE stream.
- **Consequences:** the provider can break when OpenAI changes the backend.
  The plugin identifies as the Codex CLI, a risk accepted by publishing.

## ADR-04: Credentials only in `SecretStorage`

- **Context:** `data.json` may sync across devices and be read by other tools.
- **Decision:** API keys and OAuth tokens are stored only in Obsidian's
  `SecretStorage` (OS keychain), one key per provider.
- **Consequences:** users enter keys again on each device.

## ADR-05: Static system prompt, per-turn context in the user message

- **Context:** providers cache an unchanged prompt prefix, which cuts cost
  and latency.
- **Decision:** the system prompt never contains per-turn data; the active
  note and selection go into the user message.
- **Consequences:** prompt changes must keep the system prompt static.

## ADR-06: Three providers only

- **Context:** every provider multiplies the cases to test on mobile.
- **Decision:** Anthropic, OpenAI and ChatGPT sign-in. No provider
  marketplace, no local models.
- **Consequences:** requests for more providers are declined unless one
  replaces another.

## ADR-07: No vault index

- **Context:** indexing costs memory and battery on phones and needs
  background work.
- **Decision:** `search_vault` scans files on demand with a cap.
- **Consequences:** search is slower on very large vaults, but predictable.

## ADR-08: Model lists and capabilities come from the providers

- **Context:** hardcoded model lists went stale and blocked new models.
- **Decision:**
  - Load each provider's model list from its API.
  - Cache it in `data.json` per account for 24 hours.
  - Use its capability data (e.g. reasoning levels) instead of model-name
    rules.
  - Keep only fallback defaults in code.
- **Consequences:** new models appear without a release. Where a provider
  doesn't report capabilities (OpenAI), the model's own defaults are used.

## ADR-09: Separate plugin "Chatting with AI Minus"

- **Context:** the fork adds and removes features independently of
  upstream and is published on its own.
- **Decision:** own plugin ID `chatting-with-ai-minus`, own keychain keys,
  CSS prefix and view type, and no import of data from Chatting with AI.
  Upstream's migration code from its older `obsidian-chatting` ID is
  removed.
- **Consequences:** both plugins can be installed side by side. Users of
  the original set up the provider again. Upstream fixes are ported by
  hand.

## ADR-10: arc42 for architecture, KISS for everything else

- **Context:** docs were spread over the README, agent instructions and
  plan files, partly duplicated.
- **Decision:**
  - Architecture lives in `docs/arc42/`, one file per arc42 section.
  - Other docs (README, AGENTS.md, test/README.md) stay short and point to
    arc42.
  - Every doc starts with a sentence saying what belongs in it.
- **Consequences:** each fact has one home; changes update one file.
