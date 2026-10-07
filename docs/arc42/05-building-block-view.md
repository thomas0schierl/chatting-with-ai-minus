# 5. Building block view

> **Belongs here:** the modules under `src/`, what each is responsible for,
> and how they depend on each other. Update it when a file is added,
> removed or changes its job. **Elsewhere:** how they work together over
> time (→ [6](06-runtime-view.md)), rules that apply to all of them
> (→ [8](08-crosscutting-concepts.md)).

## Overview

```
main.ts ──▶ settings.ts ─────────────┐
   │                                 ▼
   ├──▶ ui/chat-view.ts ──▶ ui/ChatContainer.svelte
   │          │  └──▶ voice/controller.ts ──▶ voice/session.ts (WebRTC)
   │          │        voice/protocol.ts; routes: voice/openai-live.ts,
   │          │        voice/codex.ts (unofficial, ADR-14)
   │          ▼
   └──▶ agent/loop.ts ──▶ api/client.ts ──▶ api/anthropic.ts
          │    │                       ├──▶ api/openai.ts ────────┐
          │    │                       └──▶ api/chatgpt-oauth.ts ─┤──▶ api/responses-format.ts
          │    │                 (all three adapters ──▶ api/stream.ts)
          │    ▼                                    │              │
          │  tools/registry.ts, tools/executor.ts   ▼              │
          ▼                                auth/chatgptOAuth.ts    │
   agent/context.ts, system-prompt.ts,     auth/chatgptOAuthStore  │
   history.ts                                                      │
                       api/model-catalog.ts ◀── adapters, settings ┘
```

All modules share types from `types.ts` and the JSON readers in `json.ts`;
`plugin-id.ts` holds the plugin ID;
`images.ts` (image limits and re-encoding) serves the image tools;
`chat-state.ts` (conversation records, format and migrations of
`chat-state.json`) serves `main.ts`; `platform/lifecycle.ts` (foreground
or background, ADR-15) serves `main.ts`, the agent loop, `api/stream.ts`
and the chat view; `debug.ts` (the optional debug log) serves all of
them; `diagnostics/capability-check.ts` (the device check) serves
`main.ts`; `styles.css` holds the global styles (the build adds the
components' scoped ones).

## Modules

| Module | Responsibility |
|---|---|
| `main.ts` | Plugin entry. Loads and saves settings (`data.json`) and API keys (SecretStorage), holds the conversations (the active one's API history lives in the agent loop), creates, switches, renames and deletes them, loads and saves them (`chat-state.json`, through `chat-state.ts`), wires the ChatGPT OAuth service, registers the view, ribbon icon, commands and context menus. Picks the voice route (`voiceRoute()`) and saves the OpenAI key from the voice settings. Starts the lifecycle hints and saves the chats when the app goes to the background. |
| `settings.ts` | Settings tab: provider, API key or ChatGPT connect/disconnect, model picker with catalog refresh, thinking level, web search, Enter sends message, Follow the AI's edits, iteration limit, the Voice group (route: OpenAI API key by default, or the unofficial ChatGPT plan after a confirmed risk warning; OpenAI key with an access check, voice, microphone mode), and Debug log (toggle, Copy, Clear). The Test buttons ask for one word with the lightest thinking level the catalog lists and no web search (`connectionTest`). Also the sign-in modals and the chat header label. |
| `ui/chat-view.ts` | Obsidian `ItemView` that mounts the Svelte component and connects its events to the agent loop callbacks; turns text deltas into a growing assistant message. Adds an entry to the history and shows it in one step (`append`), rendered as a reload renders it; only a streamed answer and a tool card are shown while they arrive. Gives each user turn its ID; edit and regenerate cut both histories before a turn and run it again; copies an answer's Markdown. New chat, switching and deleting the current conversation stop a running turn first, then show the other conversation. Starts and ends voice conversations; a delegated request runs through the same turn function, with hooks that pass progress and the answer to the voice. Back from the background (ADR-15): shows "Resuming…" and drops the failed attempt's streamed text; marks the conversation's running turn (`pendingTurn`) and offers Continue for one cut off; on mobile mutes voice in the background, reconnects or ends it. |
| `ui/ChatContainer.svelte` | The whole chat UI: a header with the conversation title, model, history, the eye button (follow the AI's edits), Clear (a red trash icon, folded away in an empty chat) and New chat buttons; the history list (a drawer over the chat: open, rename inline, delete with confirmation); messages (rendered as Obsidian Markdown, a streamed answer at most every 100 ms), tool steps (one quiet line each, e.g. "Edited Plan" with a spinner, ✓ or red ✕; a click shows parameters and result), thinking indicator (with a label such as "Resuming…"), selection pill, the Continue bar for a turn cut off, the ChatGPT usage-limit card with **Manage usage**, the "Using ChatGPT plan / Manage usage" row above the input (ChatGPT provider), image tray (an image no longer saved shows as a chip with its name), input with one action slot (voice while empty, send once there is text or an image, while a turn runs: stop, or send with text, which adds it to the running task, shown as *Queued* until taken in; the attach button folds away while typing) and the voice bar, which takes the input row's place during a call (mic or hold-to-talk button, a pill with animated sound bars and one line: the words it hears right now, else the state; a red ✕ to end). An edit action and inline edit box on user messages; Copy under finished answers, Regenerate under the last. Sticks to the bottom while the user is there (new messages and a streaming answer follow), and sending brings it there; scrolled up, it stays put and shows a button back to the latest message. |
| `ui/tool-label.ts` | The one-line label of a tool step from its name and input: "Reading Plan…", "Edited Plan", "Editing Plan failed", "Searched for "tiles"". |
| `ui/show-in-view.ts` | Shows a spot in the main area: a text range scrolled to and highlighted, or canvas cards selected and panned to, through Obsidian's search-match ephemeral state. Uses the tab that already shows the file, else one reused follow tab. Also `changedRange()` (what an edit changed). |
| `ui/math-markdown.ts` | Converts `\(…\)`, `\[…\]` and math code fences to Obsidian's `$`/`$$` at render time, leaving code untouched. |
| `agent/loop.ts` | The agent loop: owns the message history (each user turn starts with a message carrying its turn ID) and cuts it before a turn, calls the provider, passes text deltas to the view, runs tools, handles stop (aborts the request) and `ask_user`, writes to the debug log. One abort controller per request; resends a request that failed or (mobile) stalled in the background once the app is back, and continues a turn from the saved history (`continueTurn()`, ADR-15). `steer()` adds a request to the running turn: it goes out with the next step, after the tool results. |
| `agent/history.ts` | Trims and cuts history only at the start of a user turn, so a tool call is never separated from its result. Creates turn IDs and adds them to chats saved without them. |
| `agent/context.ts` | Collects per-turn context: vault name, note count, active note path, selection, and whether the turn comes from voice. |
| `agent/system-prompt.ts` | The static system prompt and the per-turn context prefix. |
| `api/client.ts` | Picks the adapter for the current provider; one retry on rate limits while no text has been shown (not on a ChatGPT usage limit), decided from the `ProviderError`'s status and code. |
| `api/errors.ts` | `ProviderError`, the one error class the adapters throw for a provider's error answer: message, HTTP status (0 inside a stream), error code, `Retry-After` wait. |
| `api/stream.ts` | The transport for chat (ADR-12): POST with Node's `https` on desktop (no CORS check) or `fetch` on mobile, an incremental SSE parser, abort; falls back to `requestUrl()` when `fetch` fails before a response (and skips `fetch` for that URL for 10 minutes after a CORS-like failure). Returns the status, and for errors the body and the `Retry-After` wait. A `fetch` failing in the background just fails (no fallback, no skip); records when each request's data last arrived (`lastChunkAt()`); an abort settles a `requestUrl()` request at once (ADR-15). The only module using `fetch` (also for the device check) and the only one loading a Node module. |
| `api/anthropic.ts` | Anthropic Messages API adapter (streamed; thinking, prompt caching, web search, native replay). Rebuilds the message from stream events. |
| `api/openai.ts` | OpenAI Responses API adapter (`previous_response_id` chaining, full replay as fallback). |
| `api/chatgpt-oauth.ts` | ChatGPT adapter (`api.openai.com/v1/responses` with the ChatGPT-plan token): `store: false`, full replay each turn, tools in a namespace. |
| `api/responses-format.ts` | The Responses API path shared by the OpenAI and ChatGPT adapters: function tools, sending a streamed request (errors built by the adapter), unified messages to input items and back, the response rebuilt from its stream events. Also `canReplay()`, the one rule all three adapters use for sending native items back: same provider, and the model and account they were recorded for (items recorded without them replay too). |
| `api/model-catalog.ts` | Loads, caches and normalises model lists per provider and account (`secretIdentity()`: which account, the API key or the ChatGPT account, only ever stored hashed); thinking and parallel-tool capabilities, and the thinking parameters built from them. |
| `auth/chatgptOAuth.ts` | ChatGPT sign-in (authorize URL, pasted callback, token exchange, ID token check), refresh and revocation against `auth.openai.com`. |
| `auth/chatgptOAuthStore.ts` | Reads and writes the ChatGPT credential, registration and pending sign-in in SecretStorage. |
| `auth/rs256.ts` | RS256 signature check for ID tokens in plain JS (BigInt, `@noble/hashes`), since SubtleCrypto may be missing on mobile. |
| `voice/protocol.ts` | The voice wire format: parses data-channel events of both dialects (GPT-Live `session.*`, Codex's `delegation.created` …), builds the speak and progress events in chunks (sizes in [6](06-runtime-view.md#voice-conversation-voice-adr-11)), our voice instructions, and the recent chat as seed messages. |
| `voice/session.ts` | One WebRTC voice connection: microphone, peer connection, remote audio, `oai-events` data channel; waits for the start, sends events, mutes the track, tells whether it is still connected, ends with `session.close`. The route creates the call. |
| `voice/controller.ts` | The voice conversation: the live caption (the user's current words, cleared once the voice answers) and state for the voice bar, delegation (waits for the transcript when the event has no text; as Codex, what was said since the last request goes along as context), runs the request as a chat turn, sends progress and the answer back. A new delegation while its turn runs steers that turn (`AgentLoop.steer`, with what was said before it) instead of stopping it; one that arrives after the turn's last step runs as the next turn. In the background (mobile) the microphone is off and a lost call isn't reported; on the return it says whether the call still works. |
| `voice/openai-live.ts` | The official route: `POST /v1/live/sessions` with the OpenAI API key; the voice list; the access check. |
| `voice/codex.ts` | The unofficial route (ADR-14): the Codex sign-in for voice (device code; while the user signs in in the browser it waits for Obsidian to be in front again and retries network errors; refresh, SecretStorage), the call on Codex's route, its voices, settings rows, sign-in dialog and the risk warning to confirm (`CodexRiskModal`). |
| `diagnostics/capability-check.ts` | The *Check device capabilities* command: platform, microphone, a local WebRTC offer, streaming `fetch` to OpenAI and Anthropic (with a key: a short streamed answer, then an aborted one), and live voice (with an OpenAI key: `gpt-live-1` in the model list, then one GPT-Live session through the voice code, closed as soon as it has started). Results in a modal to copy, without keys. |
| `tools/registry.ts` | The 18 tool definitions (JSON Schema) offered to the model. |
| `tools/executor.ts` | Runs a tool call against the Obsidian vault and returns a result (text, and images for `view_image` and `view_canvas`) or an error for the model. Enforces a turn's selection scope (only the selected text of that note changes). Editing tools add what they changed (`focus`: a range, or canvas card IDs) for following the edits; it never reaches the model or the saved chat. |
| `tools/canvas.ts` | JSON Canvas 1.0 without vault access: parse, write in Obsidian's format, the outline for `read_canvas`, the `edit_canvas` operations (IDs, placement without overlap, validation) and the searchable canvas text. |
| `tools/canvas-render.ts` | Draws a canvas for `view_canvas` with Canvas 2D: layout and scaling (whole canvas or one group or node), groups, cards with plain text, image files, links, edges with arrows and labels, colour presets, an ID tag per node, and the text legend. The drawing surface and image loading are passed in, so tests use fakes. |
| `images.ts` | Image limits (5 MB, 2048 px long side) and re-encoding via `createImageBitmap` and `<canvas>`, shared by the image tools. Attachments in `ChatContainer.svelte` still have their own copy. |
| `chat-state.ts` | The conversation record (with the marker of a running turn, `pendingTurn`), the saved format and its version, titles (first user message), per-conversation caps, the one-time migrations from older versions (turn IDs for chats saved without them; image data dropped from the visible history; the single chat becoming the first conversation), and storing each image once: the visible history keeps an image's name, type and size, and gets its data back from the API history on load. |
| `platform/lifecycle.ts` | Foreground or background (ADR-15), from the lifecycle hints listed in [6](06-runtime-view.md#back-from-the-background-adr-15). Records when the app went away; `isHidden()`, `hiddenSince(t)`, `whenVisible()`, and listeners for leaving and coming back (with the time away). |
| `platform/screen-awake.ts` | Keeps the screen on while an answer is generated or a voice call runs (Screen Wake Lock API): holders count, the lock is asked for again when the app is back (the system drops it in the background), nothing where the API is missing. |
| `types.ts` | Settings, unified message and response types, defaults. |
| `debug.ts` | `debugLog()`: requests, errors, resends, lifecycle hints and voice events to `debug.log` in the plugin folder, only while the *Debug log* setting is on (`setDebugLogging`); `readDebugLog`/`clearDebugLog` for the *Copy debug log* command and the settings buttons. |
| `json.ts` | Reading untrusted JSON without casts: `isRecord` (objects, not arrays), `asRecord`, `getNestedString`, and `readJson` for a `requestUrl()` response whose `json` getter may throw. |
| `globals.d.ts` | Declares the `resume` document event that Obsidian's mobile apps fire on returning to the foreground. |
| `plugin-id.ts` | The plugin ID, used for keychain keys, paths and User-Agents. |

## Tools

| Tool | Obsidian API | Notes |
|---|---|---|
| `read_document` | `vault.cachedRead()` | Active note if no path given |
| `edit_document` | `vault.process()` / `vault.modify()` | Find/replace, insert, or replace all |
| `search_vault` | `getMarkdownFiles()`, `getFiles()` + `cachedRead()` | Linear scan of notes and canvases (card text, group and edge labels, with the node or edge ID), up to 50 results |
| `read_file` | `vault.getFileByPath()` + `cachedRead()` | Any text file, raw; refuses images (hint: `view_image`) and other binary files by extension |
| `view_image` | `vault.readBinary()` | PNG, JPEG, GIF or WebP, returned as an image; scaled down past 2048 px or 5 MB (GIFs are never re-encoded) |
| `read_canvas` | `vault.getFileByPath()` + `cachedRead()` | `.canvas` only: groups with their nodes, other nodes, edges, with IDs, positions and sizes |
| `view_canvas` | `cachedRead()`, `readBinary()` for image nodes | `.canvas` only: a PNG of the layout (at most 1600 px, optional `focus` on a group or node) and a legend of the node tags; Markdown in cards is drawn as plain text |
| `edit_canvas` | `vault.process()` | `.canvas` only: add, update, move or remove nodes and edges; all operations or none; keeps unknown fields |
| `create_file` | `vault.create()` | Creates parent folders |
| `list_files` | `vault.getFiles()` | Up to 100 results |
| `rename_file` | `fileManager.renameFile()` | Updates links |
| `delete_file` | `fileManager.trashFile()` | Respects the user's trash setting |
| `open_document` | `ui/show-in-view.ts` (`openFile()` / `setEphemeralState()`) | Optional `text` (scrolled to and highlighted) or canvas `node_id` (selected); only when the user asks |
| `get_properties` | `metadataCache.getFileCache()` | Frontmatter |
| `set_properties` | `fileManager.processFrontMatter()` | Merge or remove keys |
| `get_backlinks` | `metadataCache.resolvedLinks` | |
| `get_current_datetime` | `Date` | User's locale and time zone |
| `ask_user` | UI callback | Pauses the loop until the user answers |
