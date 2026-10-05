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
| No Node.js modules on mobile | No local servers or file-system APIs outside the vault adapter; the ChatGPT sign-in can't catch its `127.0.0.1` callback, so the user pastes its address. |
| iOS `response.json` throws on non-JSON bodies | Read `.json` inside `try`, fall back to `.text`. |
| Secrets API is Obsidian `SecretStorage` (IDs: lowercase letters, digits, dashes) | Key names follow that pattern. |

## External services

| Constraint | Consequence |
|---|---|
| ChatGPT plan use for open-source apps ("Sign in with ChatGPT") is a preview | It can change. Requests need `store: false` and `stream: true`, the full history in `input` (no `previous_response_id`) and function tools inside a namespace; hosted tools other than web search, audio input and several request fields are rejected. |
| The sign-in redirects only to `http://127.0.0.1:<port>/auth/callback` | Only the port may vary; the same URI goes into the authorize request and the code exchange. |
| ChatGPT sign-in spends the user's ChatGPT plan and its limits | The provider is optional; API-key providers stay available. Usage-limit errors link to ChatGPT's usage settings. |
| Providers decide which models an account may use | A model in the list can still be rejected; errors must say so. |

## Organisational

| Constraint | Consequence |
|---|---|
| MIT licence, derived work | Keep the upstream copyright lines in `LICENSE`. |
| Obsidian community plugin guidelines | Sentence-case UI text, no `innerHTML`, no default hotkeys, etc. Checked in review. |
| Own plugin ID `chatting-with-ai-minus` | Must not share IDs, keychain keys or CSS classes with Chatting with AI, so both can be installed. |
