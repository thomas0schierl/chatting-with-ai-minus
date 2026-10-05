# 8. Crosscutting concepts

> **Belongs here:** rules and mechanisms that apply across modules:
> persistence, errors, mobile, security, logging, UI conventions.
> **Elsewhere:** single flows (→ [6](06-runtime-view.md)), the reasons
> behind them (→ [9](09-architecture-decisions.md)).

## Persistence

| Store | Content | Limits |
|---|---|---|
| `data.json` (`saveData`) | Provider, model, thinking level, iteration limit, web search, model catalogs (hashed account key, models with their capabilities, fetch time, Codex version) | API key always saved as `""`; at most 3 catalog entries |
| SecretStorage `chatting-with-ai-minus-api-key-<provider>` | API key per provider | |
| SecretStorage `chatting-with-ai-minus-chatgpt-oauth` | OAuth credential (JSON) | Cleared by writing `""` |
| `chat-state.json` in the plugin folder | Visible history (last 100 entries) and API history (last 80 messages), including images and native replay items | Written after every turn, Stop, Clear and unload; never before it has been read at start |
| `debug.log` in the plugin folder | Requests and errors | Only when `DEBUG = true` in `agent/loop.ts` |

Settings and catalogs are checked field by field when loaded; anything
unexpected is dropped. All writes are best-effort and never block the chat.

## Error handling

- **Adapters** use `requestUrl({ throw: false })`, check the status and
  throw an error with the provider's message. ChatGPT errors say how to
  recover (reconnect, other model, API key).
- **The agent loop** turns every adapter error into an error bubble that is
  kept in the history.
- **Tools never throw** to the loop. Failures and invalid arguments return
  an error result to the model.
- **Rate limits:** one retry after the server's suggested delay (5 s
  default, 30 s maximum).
- **Notices** are only for user actions (connection test, model refresh,
  copy).

## Mobile

- HTTP only through `requestUrl()`. No `fetch`, no Node modules, no
  localhost.
- No streaming; answers appear when complete.
- On iOS `response.json` throws for non-JSON bodies, so always read it
  inside `try`.
- Hashing uses pure JavaScript (`@noble/hashes`), since `SubtleCrypto`
  isn't always available.
- Images are re-encoded through a canvas when needed (HEIC, oversized):
  at most 4 per message, 5 MB each.
- 16 px input font (prevents zoom on iOS) and safe-area padding.

## Security and privacy

- Credentials only in SecretStorage (ADR-04); catalogs store only a hash of
  the account or key.
- Data leaves the device only in requests the user starts: the message,
  images, per-turn context (vault name, note count, active note path, up
  to 200 characters of selection), and note content the model reads
  through tools.
- `delete_file` moves files to the trash, as set in Obsidian.

## UI conventions

- CSS classes use the `chatting-minus-` prefix; the view type is
  `chatting-minus-view`.
- Only Obsidian CSS variables for colours and fonts, so themes work.
- UI text is English, in sentence case (Obsidian guideline).
