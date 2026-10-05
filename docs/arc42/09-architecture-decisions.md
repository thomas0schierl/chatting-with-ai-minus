# 9. Architecture decisions

> **Belongs here:** decisions that are costly to reverse, each with its
> context, the decision and its consequences. Add new ones at the end and
> never rewrite old ones; mark them superseded instead. **Elsewhere:**
> limits we didn't choose (→ [2](02-constraints.md)).

## ADR-01: All HTTP through `requestUrl()`, no streaming

- **Status:** superseded by ADR-12 (2026-10-05): chat requests stream
  with `fetch`. Narrowed before by ADR-11 (live voice audio uses WebRTC).
  Every other request still uses `requestUrl()`.
- **Context:** mobile WebViews enforce CORS, and `requestUrl()` is the only
  HTTP API that works on every platform. It returns complete responses only.
- **Decision:** every request uses `requestUrl()`. Answers appear when
  complete; streamed responses (Codex) are parsed from the buffered SSE text.
- **Consequences:** no token-by-token output; long answers show a thinking
  indicator until done.

## ADR-02: ChatGPT sign-in with the Device Authorization Flow

- **Status:** superseded by ADR-13 (2026-10-05).
- **Context:** a browser-redirect login needs a localhost server, which
  mobile can't run.
- **Decision:** the user opens a verification URL in any browser and enters
  a code; the plugin polls for the token. Tokens refresh automatically.
- **Consequences:** works on all platforms; login takes one extra step.

## ADR-03: The Codex backend is driven like the Codex CLI

- **Status:** superseded by ADR-13 (2026-10-05).
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

## ADR-11: Live voice through the OpenAI Realtime API over WebRTC

- **Status:** accepted. Open until the device spike: Realtime API or
  GPT-Live (both OpenAI, both WebRTC). Settled: the ChatGPT sign-in can't
  get voice, so voice needs an OpenAI API key (GAP-013).
- **Context:** users want a voice mode like in the ChatGPT, Claude and
  Codex apps: talk, hear the answer, interrupt (GAP-013). That needs a
  continuous two-way audio stream, which `requestUrl()` can't carry.
  WebRTC isn't HTTP, so the CORS reason behind ADR-01 doesn't apply to it.
  Of the three providers, only OpenAI offers a speech-to-speech API.
- **Decision:**
  - Live voice uses the OpenAI Realtime API over a WebRTC peer
    connection: audio both ways, plus a data channel for events and tool
    calls.
  - The two HTTP setup calls go through `requestUrl()` as usual: minting
    a short-lived client secret, and exchanging the WebRTC offer.
  - Vault tools run through the existing tool executor, and both sides'
    transcripts are added to the chat history.
- **Consequences:**
  - Voice needs microphone and WebRTC support in the Obsidian apps, to be
    confirmed on iOS and Android before building.
  - It works with an OpenAI API key, and with the ChatGPT sign-in only if
    that account can get Realtime credentials (open).
  - Anthropic users get no voice mode.
  - Voice runs only while the chat panel is open.

## ADR-12: Stream chat answers with `fetch`, `requestUrl()` as fallback

- **Status:** accepted 2026-10-05; supersedes ADR-01 for chat requests.
- **Context:**
  - Users expect answers to appear as they're written, as in the ChatGPT
    app. `requestUrl()` returns complete responses only and can't be
    cancelled, so long answers showed a thinking indicator until done, and
    Stop could only ignore the result.
  - ADR-01 assumed the providers reject cross-origin `fetch`. Checked on
    2026-10-05 for Obsidian's origins (`app://obsidian.md`,
    `capacitor://localhost`, `http://localhost`): Anthropic
    `/v1/messages` answers with `Access-Control-Allow-Origin: *` when the
    request sends `anthropic-dangerous-direct-browser-access: true`;
    OpenAI `/v1/responses` (OpenAI and ChatGPT providers) always does.
- **Decision:**
  - Chat requests of all three providers send `stream: true` through one
    transport module, `api/stream.ts`: `fetch` with a streamed body, an
    incremental SSE parser, and an `AbortController` that Stop triggers.
  - The adapters rebuild from the stream events the same response the
    non-streamed API returns (Anthropic content blocks with thinking
    signatures, citations and server tool blocks; Responses output items),
    so history, persistence and native replay are unchanged. Text deltas
    go through `onTextDelta` to the chat view; tool calls run only once the
    response is complete.
  - If `fetch` fails before any response (CORS block, network error), the
    same request goes through `requestUrl()`, and its buffered SSE goes
    through the same parser: the answer appears at once. Once that
    fallback has worked, the session skips `fetch`. Such a request can't be
    cancelled; Stop ignores its result.
  - Sign-in, model lists and all other HTTP stay on `requestUrl()`.
- **Consequences:**
  - Answers appear as they're written; Stop cancels the request.
  - Two transport paths. The tests run both: the harness `fetch` fails
    like a CORS block unless a test supplies a streamed body.
  - The rate-limit retry happens only before any text was shown.
  - **Plugin review:** Obsidian's review lint (`eslint-plugin-obsidianmd`)
    warns about every `fetch` (`no-restricted-globals`, a warning, not an
    error), and its config forbids switching the rule off in a comment.
    `fetch` is kept in `api/stream.ts` (and the device check in
    `diagnostics/capability-check.ts`), so the review sees one justified
    use. If review refuses it, removing the `fetch` call leaves the
    `requestUrl()` path, i.e. ADR-01's behaviour.
  - **Mobile:** not yet verified on a device whether the iOS and Android
    apps deliver a streamed `fetch` body (the *Check device capabilities*
    command tests it). If `fetch` is blocked there, the fallback keeps chat
    working without streaming.
  - API keys and tokens travel in `fetch` headers from the user's device
    to the provider, as before with `requestUrl()` (§8).

## ADR-13: ChatGPT sign-in through OpenAI's official route, with a pasted callback

- **Status:** accepted 2026-10-05; supersedes ADR-02 and ADR-03 (shipped,
  GAP-019 closed).
- **Context:**
  - The ChatGPT provider posed as the Codex CLI and called Codex's
    internal backend (GAP-019).
  - OpenAI's "Sign in with ChatGPT" for open-source apps is the sanctioned
    way.
  - Its login redirects to a loopback callback on `127.0.0.1`, which mobile
    apps can't serve. But the redirect URL already carries the result
    (`code`, `state`, issued `client_id`).
- **Decision:**
  - Sign in with OpenAI's authorize endpoint, PKCE, and the app's own
    issued client ID.
  - After signing in, the user copies the callback URL from the browser
    into the plugin, on every platform. Automatic capture on desktop may
    follow.
  - Chat and model lists use `api.openai.com/v1` with the ChatGPT-plan
    token.
- **Consequences:**
  - A sanctioned, documented route; answers stream (ADR-12).
  - One extra copy step at sign-in; each device signs in separately.
  - The programme is a preview and may change.
  - Users of the old route sign in again.
