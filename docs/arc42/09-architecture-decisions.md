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
- **Amended by ADR-16 (2026-10-07):** the vault's root `AGENTS.md` is part
  of the system prompt; it changes only when the user edits it.

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

## ADR-11: Live voice through OpenAI GPT-Live over WebRTC, with client delegation

- **Status:** accepted; settled 2026-10-05 (was open between the Realtime
  API and GPT-Live until then). Built (GAP-013 closed); not yet verified
  live or on phones (§10 live checks, §11).
- **Context:** users want a voice mode like in the ChatGPT, Claude and
  Codex apps: talk, hear the answer, interrupt. That needs a continuous
  two-way audio stream, which `requestUrl()` can't carry. WebRTC isn't
  HTTP, so the CORS reason behind ADR-01 doesn't apply to it. Of the three
  providers, only OpenAI offers a speech-to-speech API; OpenAI's official
  ChatGPT-plan access (ADR-13) excludes audio. Two OpenAI options: the
  Realtime API, where the voice model itself calls our tools, and
  GPT-Live, where the voice model only talks and hands tasks to the app
  ("delegation").
- **Decision:**
  - **GPT-Live with client delegation.** The voice model (`gpt-live-1`)
    talks; when it needs an answer it delegates. The request runs as a
    normal chat turn through the chat view and the agent loop, on
    whichever chat provider is selected (Anthropic, OpenAI or the ChatGPT
    plan), with a line in the per-turn context asking for a short,
    speakable answer (the system prompt stays static, ADR-05). Tool
    progress goes back as silent context (`session.thinking.append`), the
    answer as text to speak (`session.commentary.append`), in chunks.
  - **Official route:** the user's OpenAI API key, shared with the OpenAI
    provider's keychain entry. `POST /v1/live/sessions` through
    `requestUrl()` carries the WebRTC offer and returns the answer; audio
    and events then go over the peer connection and its `oai-events` data
    channel.
  - **Voices:** no API lists them, so each route has one constant list
    taken from the docs (`gpt-live-1`'s 32 voices). This is an exception
    to ADR-08.
  - **Steering:** a request while the voice turn runs is added to that
    turn after its current step instead of stopping it, as in the chat
    apps; one that comes after the turn's last step runs as the next
    turn. While `ask_user` waits, the request is the answer.
  - **No server push-to-talk:** GPT-Live always detects turns itself.
    *Hold to talk* is done locally: the microphone track is enabled only
    while the button is held.
- **Consequences:**
  - One agent, one conversation: voice and typed turns share tools,
    history and turn IDs. Only the voice runs on OpenAI.
  - Billed per minute ($0.05/min, silence included) on the user's OpenAI
    account; the settings say so.
  - Small talk the voice model handles itself is only heard: the live
    caption shows only the user's words, and the history doesn't keep it.
  - Voice runs only while the chat panel is open, and ends with a
    conversation switch, a new chat, Clear or closing the view.
  - Android app (Obsidian 1.13.8, 2026-10-06, *Check device
    capabilities*): microphone and a WebRTC offer work; `fetch` to OpenAI
    and Anthropic is allowed (CORS). Live calls work on Android
    (2026-10-06, incl. Bluetooth), and the official route with an OpenAI
    API key was tested live on 2026-10-07. The iOS app is not verified yet.

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
  - **Desktop streams through Node's `https`** (Electron), which no CORS
    check applies to. Found in Obsidian on 2026-10-05: with a ChatGPT-plan
    token, `api.openai.com` answers *without* CORS headers (the fake-key
    preflight above doesn't show this), so browser `fetch` is blocked for
    the ChatGPT provider.
  - **Mobile streams with `fetch`** (Anthropic, OpenAI API key). ChatGPT
    can't stream there.
  - If `fetch` fails before any response (CORS block, network error), the
    same request goes through `requestUrl()`, and its buffered SSE goes
    through the same parser: the answer appears at once. When `fetch`
    failed like a CORS block (a `TypeError`) and that fallback reached
    the server, later requests to that URL skip `fetch` for 10 minutes;
    a brief network failure looks the same, so the block doesn't last
    the session. Such a request can't be cancelled; Stop ignores its
    result.
  - Sign-in, model lists and all other HTTP stay on `requestUrl()`.
- **Consequences:**
  - Answers appear as they're written; Stop cancels the request.
  - Two transport paths. The tests run both: the harness `fetch` fails
    like a CORS block unless a test supplies a streamed body.
  - The rate-limit retry happens only before any text was shown.
  - **Plugin review:** Obsidian's review lint (`eslint-plugin-obsidianmd`)
    flags the bare global `fetch` (`no-restricted-globals`), and its config
    forbids switching the rule off in a comment. The one call,
    `browserFetch` in `api/stream.ts`, is written `window.fetch`; the
    device check (`diagnostics/capability-check.ts`) uses it too, so the
    review sees one justified use. If review refuses it, removing that
    call leaves the `requestUrl()` path, i.e. ADR-01's behaviour.
  - **Mobile:** not yet verified on a device whether the iOS and Android
    apps deliver a streamed `fetch` body (the *Check device capabilities*
    command tests it). If `fetch` is blocked there, the fallback keeps chat
    working without streaming. ChatGPT answers on mobile always arrive
    whole.
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

## ADR-14: Opt-in Codex voice route (unofficial)

- **Status:** accepted 2026-10-05 for private builds only. Updated
  2026-10-07: the maintainer decided to ship the route in every build,
  public releases included, off by default, behind a confirmed risk
  warning, at the user's own risk. Partly revisits ADR-13.
- **Context:**
  - OpenAI's official ChatGPT-plan access excludes audio (ADR-11), so the
    official voice needs an API key and costs per minute.
  - Codex's own voice mode runs on the user's ChatGPT plan through an
    internal route: it signs in as the Codex app (device code flow) and
    creates calls at `chatgpt.com/backend-api/codex/realtime/calls`. The
    route is undocumented, may change or be blocked, and using it as
    another app is a risk to the user's account.
- **Decision:**
  - A second voice route, in every build (until 2026-10-07 only in
    private builds, behind a build flag that is now gone).
  - Off by default: the voice route is "OpenAI API key". Choosing
    "ChatGPT plan (unofficial)" opens a warning the user must confirm,
    and the route's setting says it is at the user's own risk. The risk
    as stated: it signs in as OpenAI's Codex app and uses Codex's
    internal, undocumented voice service with the ChatGPT plan; it is
    not offered or approved by OpenAI, may stop working at any time, and
    OpenAI could treat it as a breach of its terms and restrict or
    suspend the ChatGPT account used. The official route has none of
    these risks.
  - A separate sign-in as the Codex app
    (client `app_EMoamEEZ73f0CkXaXp7hrann`, device code at
    `auth.openai.com/codex/device`), stored in its own SecretStorage key,
    independent of the ChatGPT provider's sign-in.
  - The same voice core as the official route. The call carries Codex's
    headers (`originator: codex_cli_rs`, `openai-alpha: quicksilver=v2`,
    `ChatGPT-Account-ID`, session IDs, the latest Codex version) and
    model `gpt-live-1-codex`. Codex itself reads events over a separate
    WebSocket with auth headers; we read the WebRTC data channel and
    parse both event dialects (Codex's `delegation.created`, … and
    GPT-Live's `session.*`), picking the outbound one from the first
    events.
  - Desktop and mobile alike: call creation, sign-in and refresh go
    through `requestUrl()`, and the device code needs no redirect. A
    WebSocket fallback, if the data channel carries no events, would be
    desktop-only (browsers can't set its headers).
- **Consequences:**
  - Every user can turn the route on. This likely conflicts with
    Obsidian's community directory review and with OpenAI's terms:
    reviewers may reject the plugin, and OpenAI may act against the
    accounts used (risk in §11). The official route with an API key
    stays the default.
  - It can break without notice. Checked on desktop 2026-10-05: the
    data channel carries the events in Codex's dialect, so no WebSocket
    is needed; two requests ran on the ChatGPT plan with vault tools and
    were spoken. Phones: §10.

## ADR-15: Recover instead of running in the background on mobile

- **Status:** accepted 2026-10-05. Built; not yet verified on phones
  (§10 phone checklist).
- **Context:** users switch apps or lock the phone while an answer or a
  voice conversation runs.
  - **iOS** suspends a backgrounded app after a few seconds unless it
    has a background mode or task ([Apple TN2277](https://developer.apple.com/library/archive/technotes/tn2277/_index.html)):
    no JavaScript runs, requests open then fail or hang when it resumes,
    and WebRTC drops after about 30 s without its consent checks.
    WKWebView mutes microphone capture in the background
    ([WebKit bug 226620](https://bugs.webkit.org/show_bug.cgi?id=226620));
    Obsidian likely lacks the `audio` background mode. iOS may also end
    the web view: the next start is a page load, with no event before.
  - **Android** keeps JavaScript running for a while (Capacitor's
    default), then freezes or kills the app; Android 14 freezes cached
    apps about 10 s after they become cached
    ([cached apps freezer](https://source.android.com/docs/core/perf/cached-apps-freezer)).
    Without a foreground service the microphone records silence.
  - **Desktop** (Electron): a minimised window keeps running turns (Node
    `https`) and WebRTC voice.
  - Obsidian gives plugins no lifecycle event and no background
    execution on mobile ([forum request](https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906)).
    Capacitor fires `pause` and `resume` on the document
    ([CapacitorBridge.swift](https://github.com/ionic-team/capacitor/blob/main/ios/Capacitor/Capacitor/CapacitorBridge.swift));
    `pause` may not get to run before the suspension. Capacitor's plugin
    APIs (`window.Capacitor.Plugins`) are undocumented for Obsidian
    plugins and a review risk.
  - `requestUrl()` can't be cancelled; its native request is suspended
    with the app.
- **Decision:** don't try to keep working in the background; recover when
  the app is back.
  - `platform/lifecycle.ts` takes the platform's hints (listed in §6),
    records when the app went away, and decisions are made on the return.
  - A request that failed while the app was in the background is sent
    again on the return, in the same turn from the same history, a
    limited number of times. A `fetch` failing in the background neither falls
    back to `requestUrl()` nor marks the URL fetch-blocked (ADR-12). On
    mobile, a request that stays silent for a while after the return is
    aborted (one abort controller per request; `requestUrl()` raced
    against the abort) and resent.
  - Leaving the app saves the chats. A running turn marks its
    conversation (`pendingTurn`); found after a restart with an answer
    still owed, the chat offers **Continue**, never automatically: the
    user may have moved on, and the turn may change notes.
  - Voice on mobile: the microphone is off in the background; back soon
    with the call connected, it continues; otherwise it is replaced by a
    new call seeded from the chat; after a minute in the background it
    ends. Desktop is unchanged.
  - The limits and times are in §6.
- **Consequences:**
  - Nothing happens while the phone is away; answers arrive after the
    return, and completed steps of a turn (tool calls included) aren't
    repeated.
  - A resent request costs its tokens again, also when the provider had
    finished it but the answer never arrived; a slow request may be
    given up after a short silence and resent.
  - The hints can come late or not at all; a failure while the app counts
    as visible is an error as before. Continue covers what the hints miss
    on iOS.
  - Desktop: only a request that fails while the window is hidden is
    resent on the return; no watchdog, voice unchanged.
  - Whether `pause`/`resume` fire, how long iOS lets a request finish,
    and voice after the background are to be checked on devices (§11).

## ADR-16: The vault's AGENTS.md files as instructions

- **Context:** users want standing instructions for the AI (style, where
  things go, how notes are structured) without repeating them in each
  chat. [agents.md](https://agents.md) is the shared convention for this
  (Codex, Cursor and others read it): an `AGENTS.md` at the root, more in
  subfolders for their part, the closest one winning. ADR-05 keeps the
  system prompt static for the providers' prompt caches.
- **Decision:**
  - The root `AGENTS.md` (up to 32,768 characters, as Codex caps its
    project docs) goes into the system prompt after the built-in one,
    read at the start of each turn. It changes only when the user edits
    it, so the cache holds otherwise.
  - A folder's `AGENTS.md` is added to the first tool result of the
    conversation that touches a file in that folder or below (the tool's
    `path` or `new_path`, else the active note for tools that default to
    it), outer folders first, as Claude Code loads nested `CLAUDE.md`
    files. Whether one was given is read from the history, so it comes
    once per conversation, and again when the turn that had it was cut
    away (edit, trimming, a new chat).
  - The prompt tells the model that chat messages win over the file and
    that a folder's file wins over the root's where they differ.
- **Consequences:**
  - An edit to the root file costs one uncached request.
  - Folder instructions arrive only once the AI works there: a request
    about a folder it hasn't touched yet doesn't see them.
  - Only `AGENTS.md`; other names (`CLAUDE.md`, `.cursorrules`) aren't
    read.
