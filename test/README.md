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
chat requests take the `requestUrl()` fallback and receive SSE. No credentials or network
needed. They don't prove live-service or mobile behaviour.

| File | Covers |
|---|---|
| `background.test.mjs` | Lifecycle hints; saving on leaving; a request failed or (mobile) stalled in the background resent in the same turn without duplicated text, with a limit; Continue for a turn cut off, without running tools again. |
| `canvas.test.mjs` | `read_canvas`, `edit_canvas` (placement, groups, validation), canvas text in search. |
| `chatgpt-signin.test.mjs` | ChatGPT sign-in, ID token check, refresh, sign-out, another account, retry after a 401, the request shape. |
| `chatgpt-usage.test.mjs` | Usage limit: not retried, its own message; the one-time plan welcome. |
| `client-version.test.mjs` | The Codex CLI version sent as `client_version`: cached, stable releases only, fallback. |
| `conversations.test.mjs` | New chat, switch, rename, delete, restore, titles, caps, saves one at a time, an unreadable saved file kept aside, history isolation and OpenAI chaining. |
| `typed-steering.test.mjs` | Typing while an answer runs: queued, taken in with the next step, or run next; Stop drops it. |
| `screen-awake.test.mjs` | The screen lock: held while anyone needs it, asked for again after the background, a turn holds it; the "Stopped." note. |
| `debug-log.test.mjs` | The *Debug log* setting: nothing written while off; Copy and Clear. |
| `enter-sends.test.mjs` | The *Enter sends message* setting: default, kept in `data.json`, passed to the chat. |
| `edit-document.test.mjs` | `edit_document` without content, and where it inserts. |
| `tool-label.test.mjs` | The one-line labels of tool steps per state, file names without `.md`, searches, renames, unknown tools. |
| `follow-edits.test.mjs` | Following the AI's edits: the changed range or cards, the reused follow tab and Obsidian's match state, canvas cards selected and centered (zoom out only), the follow tab closed on unload and at the next start, the setting on/off, `open_document` with a text. |
| `instructions.test.mjs` | `AGENTS.md` (ADR-16): the root file in the system prompt (and gone with it); a folder's with the first result touching it, outer first, not repeated, again after a cut; the active note counts. |
| `mentions.test.mjs` | The mention at the caret (`@`, `[[`), the files offered, the link put in; the linked files of a message and what goes to the model (notes capped, canvas outline, images, other files by name), sent before the message. |
| `web-page.test.mjs` | `read_web_page` with a stand-in DOM: the article without scripts and navigation, text answers, other types and HTTP errors refused, only http(s), parts of long pages, a page without text; its label. |
| `metadata-query.test.mjs` | `query_notes` (tags with nested ones, all or any; property values, lists, links, set; folder; sorting; limit) and `list_metadata`; their labels. |
| `undo.test.mjs` | Undo per answer: edits, new files, renames and deletes (folders too) taken back last first; files changed since named and asked about; the changes row, the note for the model with the next turn only, the row without Undo after a restart. |
| `images-once.test.mjs` | Each image saved once; the migration of older saved chats. |
| `math-markdown.test.mjs` | Math delimiters converted, code untouched. |
| `message-actions.test.mjs` | Edit, regenerate and copy through the chat view; Stop and Clear while `ask_user` waits. |
| `provider-history.test.mjs` | History encoding and replay per provider (one replay rule), tool pairs, thinking parameters, model catalogs and caching, Anthropic web search. |
| `stream-desktop.test.mjs` | Desktop streams through Node's `https` (errors, Stop); on mobile a blocked `fetch` switches only that URL. |
| `streaming.test.mjs` | SSE parsing, rebuilt responses, the `requestUrl()` fallback and when `fetch` is skipped, Stop, the rate-limit retry, a cut-off stream sent again. |
| `tools.test.mjs` | Every offered tool has a handler; `set_properties`; local date; selection quoting; saved settings checked on load. |
| `view-tools.test.mjs` | `view_image`, `view_canvas` drawing, older tool images left out of requests. |
| `voice-build.test.mjs` | The real build config: both voice routes in the bundle; all CSS in `styles.css`. |
| `voice.test.mjs` | Live voice with fake WebRTC, microphone and audio: both routes and event dialects, delegation, chunked answers, the live caption, steering (nothing stopped; answers `ask_user`; a late request runs as the next turn), hold to talk, ending, the background on mobile, the device check's session, the Codex sign-in. |

## Live checks

Live provider behaviour is checked in Obsidian itself, on desktop and on a
phone ([arc42 §10](../docs/arc42/10-quality-requirements.md#live-checks-before-a-release)).
