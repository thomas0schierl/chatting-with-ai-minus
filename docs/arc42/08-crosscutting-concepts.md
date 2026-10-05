# 8. Crosscutting concepts

> **Belongs here:** rules and mechanisms that apply across modules:
> persistence, errors, mobile, security, logging, UI conventions.
> **Elsewhere:** single flows (→ [6](06-runtime-view.md)), the reasons
> behind them (→ [9](09-architecture-decisions.md)).

## Persistence

| Store | Content | Limits |
|---|---|---|
| `data.json` (`saveData`) | Provider, model, thinking level, iteration limit, web search, model catalogs (hashed account key, models with their capabilities, fetch time) | API key always saved as `""`; at most 3 catalog entries |
| SecretStorage `chatting-with-ai-minus-api-key-<provider>` | API key per provider | |
| SecretStorage `chatting-with-ai-minus-chatgpt-oauth` | ChatGPT credential (JSON): access, refresh and ID token, expiry, granted scopes, account `sub` and email | Cleared by writing `""` on disconnect or an unusable refresh token. A record without `scopes` (former Codex sign-in) is erased on its first read |
| SecretStorage `chatting-with-ai-minus-chatgpt-sign-in` | The pending sign-in attempt (JSON): authorize URL, PKCE verifier, `state`, `nonce`, redirect URI, client ID, start time | Cleared once its code is exchanged; ignored and cleared when 10 minutes old |
| SecretStorage `chatting-with-ai-minus-chatgpt-registration` | This device's `ext_agent_host_id` (`urn:uuid:…`), the issued client ID, the registered account's `sub` and email | Kept on disconnect. Not a secret, but per device: `data.json` syncs, and each device needs its own host ID |
| `chat-state.json` in the plugin folder | Visible history (last 100 entries) and API history (last 80 messages), including images and native replay items. Images from tools are only in the API history | Written after every turn, Stop, Clear and unload; never before it has been read at start |
| `debug.log` in the plugin folder | Requests and errors | Only when `DEBUG = true` in `agent/loop.ts` |

Settings and catalogs are checked field by field when loaded; anything
unexpected is dropped. All writes are best-effort and never block the chat.

## Error handling

- **Adapters** send through `api/stream.ts`, which returns the status and,
  for errors, the body; they throw an error with the provider's message.
  Errors reported inside a stream (`error`, `response.failed`) and a stream
  that ends before its final event are errors too, never partial answers. ChatGPT errors say how to
  recover: sign in again (401), or manage usage at
  `chatgpt.com/settings/usage` (usage-limit codes).
- **The agent loop** turns every adapter error into an error bubble that is
  kept in the history.
- **Tools never throw** to the loop. Failures and invalid arguments return
  an error result to the model.
- **Rate limits:** one retry after the server's suggested delay (5 s
  default, 30 s maximum), only if no answer text was shown yet; otherwise
  the error is shown below the partial answer.
- **Notices** are only for user actions (connection test, model refresh,
  copy).

## Mobile

- HTTP through `requestUrl()`, except chat requests: they stream with
  `fetch` in `api/stream.ts` (ADR-12). No Node modules, no localhost.
- If `fetch` fails before any response (blocked by CORS, network), the same
  request goes through `requestUrl()` and the answer appears when complete;
  after one such fallback the session skips `fetch`. Whether the iOS and
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
- `delete_file` moves files to the trash, as set in Obsidian.

## UI conventions

- CSS classes use the `chatting-minus-` prefix; the view type is
  `chatting-minus-view`.
- Only Obsidian CSS variables for colours and fonts, so themes work.
- UI text is English, in sentence case (Obsidian guideline).
