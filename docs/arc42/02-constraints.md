# 2. Constraints

> **Belongs here:** limits the project can't choose: platform, external
> APIs, licence, conventions. **Elsewhere:** choices made within those
> limits (→ [9](09-architecture-decisions.md)).

## Technical

| Constraint | Consequence |
|---|---|
| Runs inside Obsidian (minimum app version in `manifest.json`) | Only the Obsidian plugin API; one bundled `main.js`. |
| Mobile apps run in a WebView that enforces CORS | `fetch` works only where the server allows Obsidian's origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`). Anthropic `/v1/messages` does with the header `anthropic-dangerous-direct-browser-access: true`, OpenAI `/v1/responses` always (checked 2026-10-05); other HTTP goes through Obsidian's `requestUrl()`. |
| `requestUrl()` returns the whole response at once and can't be cancelled | Streamed answers need `fetch` (ADR-12); when it fails, the buffered stream is parsed after it completes. |
| Obsidian's review lint warns about every `fetch` (`no-restricted-globals`) and forbids disabling it in a comment | `fetch` stays in one module (`api/stream.ts`, plus the device check); the warning is accepted. |
| No Node.js modules on mobile | No local servers or file-system APIs outside the vault adapter; the ChatGPT sign-in can't catch its `127.0.0.1` callback, so the user pastes its address. |
| iOS `response.json` throws on non-JSON bodies | Read `.json` inside `try`, fall back to `.text`. |
| Secrets API is Obsidian `SecretStorage` (IDs: lowercase letters, digits, dashes) | Key names follow that pattern. |

## External services

| Constraint | Consequence |
|---|---|
| ChatGPT plan use for open-source apps ("Sign in with ChatGPT") is a preview | It can change. Requests need `store: false` and `stream: true`, the full history in `input` (no `previous_response_id`) and function tools inside a namespace; hosted tools other than web search, audio input and several request fields are rejected. |
| The sign-in redirects only to `http://127.0.0.1:<port>/auth/callback` | Only the port may vary; the same URI goes into the authorize request and the code exchange. |
| ChatGPT sign-in spends the user's ChatGPT plan and its limits | The provider is optional; API-key providers stay available. Usage-limit errors link to ChatGPT's usage settings. |
| OpenAI's [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) for "Sign in with ChatGPT" | A one-time welcome after the first sign-in; "Using ChatGPT plan" with **Manage usage** next to the chat input; a usage limit shows its own message with **Manage usage** as the main action and is not retried. |
| Providers decide which models an account may use | A model in the list can still be rejected; errors must say so. |

## Organisational

| Constraint | Consequence |
|---|---|
| MIT licence, derived work | Keep the upstream copyright lines in `LICENSE`. |
| Obsidian community plugin guidelines | Sentence-case UI text, no `innerHTML`, no default hotkeys, etc. Checked in review. |
| Own plugin ID `chatting-with-ai-minus` | Must not share IDs, keychain keys or CSS classes with Chatting with AI, so both can be installed. |
