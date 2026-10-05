# 2. Constraints

> **Belongs here:** limits the project can't choose: platform, external
> APIs, licence, conventions. **Elsewhere:** choices made within those
> limits (→ [9](09-architecture-decisions.md)).

## Technical

| Constraint | Consequence |
|---|---|
| Runs inside Obsidian (minimum app version in `manifest.json`) | Only the Obsidian plugin API; one bundled `main.js`. |
| Mobile apps run in a WebView that enforces CORS | All HTTP goes through Obsidian's `requestUrl()`, not `fetch`. |
| `requestUrl()` returns the whole response at once | No streaming UI; streamed (SSE) responses are parsed after they complete. |
| No Node.js modules on mobile | No local servers or file-system APIs outside the vault adapter; OAuth can't use a localhost callback. |
| iOS `response.json` throws on non-JSON bodies | Read `.json` inside `try`, fall back to `.text`. |
| Secrets API is Obsidian `SecretStorage` (IDs: lowercase letters, digits, dashes) | Key names follow that pattern. |

## External services

| Constraint | Consequence |
|---|---|
| The ChatGPT/Codex backend is not a public API | It can change without notice, and requests must look like the Codex CLI's (`store: false`, `stream: true`, `originator` header, `client_version`). |
| ChatGPT sign-in needs a plan with Codex access | The provider is optional; API-key providers stay available. |
| Providers decide which models an account may use | A model in the list can still be rejected; errors must say so. |

## Organisational

| Constraint | Consequence |
|---|---|
| MIT licence, derived work | Keep the upstream copyright lines in `LICENSE`. |
| Obsidian community plugin guidelines | Sentence-case UI text, no `innerHTML`, no default hotkeys, etc. Checked in review. |
| Own plugin ID `chatting-with-ai-minus` | Must not share IDs, keychain keys or CSS classes with Chatting with AI, so both can be installed. |
