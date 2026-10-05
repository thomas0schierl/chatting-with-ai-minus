# 8. Crosscutting concepts

> **Belongs here:** rules and mechanisms that apply across modules:
> persistence, errors, mobile, security, logging, UI conventions.
> **Elsewhere:** single flows (→ [6](06-runtime-view.md)), the reasons
> behind them (→ [9](09-architecture-decisions.md)).

## Persistence

| Store | Content | Limits |
|---|---|---|
| `data.json` (`saveData`) | Provider, model, thinking level, iteration limit, web search, whether the ChatGPT plan welcome was shown, voice route, voice per route, microphone mode, model catalogs (hashed account key, models with their capabilities, fetch time) | API key always saved as `""`; at most 3 catalog entries |
| SecretStorage `chatting-with-ai-minus-api-key-<provider>` | API key per provider | The OpenAI key is also the voice key |
| SecretStorage `chatting-with-ai-minus-codex-voice` | Private builds only (ADR-14): the Codex voice credential (JSON): access, refresh and ID token, expiry, ChatGPT account ID, email | Cleared by writing `""` on sign-out |
| SecretStorage `chatting-with-ai-minus-chatgpt-oauth` | ChatGPT credential (JSON): access, refresh and ID token, expiry, granted scopes, account `sub` and email | Cleared by writing `""` on disconnect or an unusable refresh token. A refresh writes or clears only while the stored credential is still the one it started from (likewise for the Codex voice credential). A record without `scopes` (former Codex sign-in) is erased on its first read |
| SecretStorage `chatting-with-ai-minus-chatgpt-sign-in` | The pending sign-in attempt (JSON): authorize URL, PKCE verifier, `state`, `nonce`, redirect URI, client ID, start time | Cleared once its code is exchanged; ignored and cleared when 10 minutes old |
| SecretStorage `chatting-with-ai-minus-chatgpt-registration` | This device's `ext_agent_host_id` (`urn:uuid:…`), the issued client ID, the registered account's `sub` and email | Kept on disconnect; client ID, `sub` and email replaced by *Use another account*, the host ID never. Not a secret, but per device: `data.json` syncs, and each device needs its own host ID |
| `chat-state.json` in the plugin folder | `{ version: 3, activeConversationId, conversations: [{ id, title, customTitle, createdAt, updatedAt, chatHistory, agentMessages, pendingTurn? }] }`. `pendingTurn` (`{ turnId, startedAt }`) is set while a turn runs; found at start, the turn was cut off and Continue is offered (ADR-15). Optional, so no new version: an older plugin drops it. Per conversation the visible history (last 100 entries) and API history (last 80 messages, complete turns, with native replay items). Image data only in the API history; the visible history keeps each image's ID, name, type and size. Tool cards keep their call's input for display, strings cut to 300 characters and lists to 10 items (`savedToolInput()`); cards saved without it show no parameters. Older versions are migrated once on load (`chat-state.ts`): 1 → 2 turn IDs and images once, 2 → 3 the single chat becomes the first conversation | Written after every turn, Stop, Clear, new chat, switch, rename, delete and unload, and when the app goes to the background (mid-turn too, with the API history so far); never before it has been read at start. One write at a time: saves asked for during a write become one write after it, with the state at that time. Empty conversations other than the active one aren't saved. A file that can't be read is renamed to `chat-state.corrupt-<time>.json`, never overwritten |
| `debug.log` in the plugin folder | Requests and errors; voice event types | Only while the *Debug log* setting is on (`data.json`, so it syncs to other devices); it includes the user's messages, never keys. *Copy debug log* (command, or **Copy** in settings) puts it on the clipboard, **Clear** deletes it |

Settings and catalogs are checked field by field when loaded; anything
unexpected is dropped. All writes are best-effort and never block the chat.

## Error handling

- **Adapters** send through `api/stream.ts`, which returns the status and,
  for errors, the body and the `Retry-After` wait; they throw a
  `ProviderError` (`api/errors.ts`) with the provider's message, the
  status (0 inside a stream), its error code and that wait. Network errors
  pass through unchanged.
  Errors reported inside a stream (`error`, `response.failed`) and a stream
  that ends before its final event are errors too, never partial answers. ChatGPT errors say how to
  recover: sign in again (401, after one token refresh and retry), or try again later
  (`subscription_sharing_usage_unavailable`). A usage limit
  (`subscription_sharing_usage_limit_exceeded`) throws
  `ChatGPTUsageLimitError`; the chat shows it as its own message with
  **Manage usage** (`chatgpt.com/settings/usage`), also after a reload.
- **The agent loop** turns every adapter error into an error bubble that is
  kept in the history, except a request that failed or stalled while the
  app was in the background: it is sent again once the app is back, at
  most twice per turn (ADR-15).
- **Tools never throw** to the loop. Failures and invalid arguments return
  an error result to the model.
- **Rate limits and overload** (status 429 or 529, or the code
  `rate_limit_error` / `overloaded_error` from Anthropic or
  `rate_limit_exceeded` from OpenAI inside the stream; decided from the
  error's status and code, never its text): one retry after the server's
  `Retry-After` (5 s default, 30 s maximum), only if no answer text was
  shown yet, and never for a ChatGPT usage limit; otherwise
  the error is shown below the partial answer.
- **Notices** are only for user actions (connection test, model refresh,
  copy), and for saved chats that couldn't be read at start.

## Mobile

- HTTP through `requestUrl()`, except chat requests: they stream in
  `api/stream.ts` (ADR-12), with `fetch` on mobile and Node's `https` on
  desktop (loaded at runtime only when `Platform.isDesktopApp`). No other
  Node modules, no localhost.
- If `fetch` fails before any response (blocked by CORS, network), the same
  request goes through `requestUrl()` and the answer appears when complete;
  if `fetch` failed like a CORS block (`TypeError`) and `requestUrl()`
  reached the server, `fetch` is skipped for that URL for 10 minutes. Whether the iOS and
  Android apps deliver a streamed `fetch` body is still to be checked on a
  device (*Check device capabilities*).
- On iOS `response.json` throws for non-JSON bodies, so always read it
  inside `try` (`readJson()` in `json.ts`).
- Hashing uses pure JavaScript (`@noble/hashes`), since `SubtleCrypto`
  isn't always available.
- Images are re-encoded through a canvas when needed (HEIC, oversized):
  at most 4 per message, 5 MB each. `view_image` scales vault images the
  same way (`images.ts`), and `view_canvas` draws canvases with Canvas 2D
  instead of screenshotting the canvas view, which works only on desktop.
- 16 px input font (prevents zoom on iOS) and safe-area padding.
- Voice uses WebRTC and the microphone; both are checked when voice
  starts, and a missing one is shown as an error. Not yet verified in the
  iOS and Android apps.
- **Background** (ADR-15): Obsidian has no lifecycle event, so
  `platform/lifecycle.ts` takes hints (document `visibilitychange`,
  Capacitor's `pause`/`resume`, window `focus` and `pageshow`) and records
  when the app went away; code decides on the return
  (`hiddenSince(t)`, `whenVisible()`, listeners), never in the background,
  where it may not run at all. Undocumented Capacitor plugin APIs
  (`window.Capacitor.Plugins`) aren't used. The flows are in
  [6](06-runtime-view.md#back-from-the-background-adr-15): a failed or
  stalled request is resent, a turn cut off gets Continue, voice is muted
  and reconnected. Desktop windows keep running in the background; only
  a request that failed while hidden is resent there.

## Security and privacy

- Credentials only in SecretStorage (ADR-04); catalogs store only a hash of
  the account or key.
- Data leaves the device only in requests the user starts: the message,
  images, per-turn context (vault name, note count, active note path, up
  to 200 characters of selection), and note content and images the model
  reads through tools.
- ChatGPT sign-in: PKCE, `state` and `nonce` per attempt; only the full
  callback address is accepted. The ID token's RS256 signature (against
  OpenAI's JWKS), issuer, audience, expiry and nonce are checked; tokens
  never go into URLs, logs or `data.json`.
- API keys and tokens travel in request headers from the user's own
  device straight to the provider, with `fetch` as with `requestUrl()`.
  Anthropic's `anthropic-dangerous-direct-browser-access` header only
  allows that browser-style request; the key is never sent anywhere else.
- Voice: microphone audio and the recent chat (as text, to seed the
  voice) go to OpenAI while a voice conversation runs; nothing before
  the user presses the voice button.
- `delete_file` moves files to the trash, as set in Obsidian.

## UI conventions

- CSS classes use the `chatting-minus-` prefix; the view type is
  `chatting-minus-view`.
- Styles live in `src/styles.css` (global) and in each Svelte component
  (scoped; the class hash includes the plugin ID, so it differs from
  Chatting with AI's). The build writes both into `styles.css`; nothing is
  injected at runtime.
- Only Obsidian CSS variables for colours and fonts, so themes work.
- UI text is English, in sentence case (Obsidian guideline).
