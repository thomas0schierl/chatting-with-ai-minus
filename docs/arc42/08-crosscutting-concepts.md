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
| `chat-state.json` in the plugin folder | `{ version: 3, activeConversationId, conversations: [{ id, title, customTitle, createdAt, updatedAt, chatHistory, agentMessages }] }`. Per conversation the visible history (last 100 entries) and API history (last 80 messages, complete turns, with native replay items). Image data only in the API history; the visible history keeps each image's ID, name, type and size. Tool cards keep their call's input for display, strings cut to 300 characters and lists to 10 items (`savedToolInput()`); cards saved without it show no parameters. Older versions are migrated once on load (`chat-state.ts`): 1 → 2 turn IDs and images once, 2 → 3 the single chat becomes the first conversation | Written after every turn, Stop, Clear, new chat, switch, rename, delete and unload; never before it has been read at start. One write at a time: saves asked for during a write become one write after it, with the state at that time. Empty conversations other than the active one aren't saved. A file that can't be read is renamed to `chat-state.corrupt-<time>.json`, never overwritten |
| `debug.log` in the plugin folder | Requests and errors; voice event types | Only when `DEBUG = true` in `agent/loop.ts` |

Settings and catalogs are checked field by field when loaded; anything
unexpected is dropped. All writes are best-effort and never block the chat.

## Error handling

- **Adapters** send through `api/stream.ts`, which returns the status and,
  for errors, the body; they throw an error with the provider's message.
  Errors reported inside a stream (`error`, `response.failed`) and a stream
  that ends before its final event are errors too, never partial answers. ChatGPT errors say how to
  recover: sign in again (401, after one token refresh and retry), or try again later
  (`subscription_sharing_usage_unavailable`). A usage limit
  (`subscription_sharing_usage_limit_exceeded`) throws
  `ChatGPTUsageLimitError`; the chat shows it as its own message with
  **Manage usage** (`chatgpt.com/settings/usage`), also after a reload.
- **The agent loop** turns every adapter error into an error bubble that is
  kept in the history.
- **Tools never throw** to the loop. Failures and invalid arguments return
  an error result to the model.
- **Rate limits and overload** (429, 529, or Anthropic's
  `rate_limit_error` / `overloaded_error` inside the stream): one retry after the server's suggested delay (5 s
  default, 30 s maximum), only if no answer text was shown yet, and never
  for a ChatGPT usage limit; otherwise
  the error is shown below the partial answer.
- **Notices** are only for user actions (connection test, model refresh,
  copy), and for saved chats that couldn't be read at start.

## Mobile

- HTTP through `requestUrl()`, except chat requests: they stream with
  `fetch` in `api/stream.ts` (ADR-12). No Node modules, no localhost.
- If `fetch` fails before any response (blocked by CORS, network), the same
  request goes through `requestUrl()` and the answer appears when complete;
  if `fetch` failed like a CORS block (`TypeError`) and `requestUrl()`
  reached the server, `fetch` is skipped for that URL for 10 minutes. Whether the iOS and
  Android apps deliver a streamed `fetch` body is still to be checked on a
  device (*Check device capabilities*).
- On iOS `response.json` throws for non-JSON bodies, so always read it
  inside `try`.
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
