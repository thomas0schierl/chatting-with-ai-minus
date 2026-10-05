# 3. Context and scope

> **Belongs here:** who and what the plugin talks to, and over which
> interfaces. **Elsewhere:** the plugin's inside (→ [5](05-building-block-view.md)),
> request details per flow (→ [6](06-runtime-view.md)).

## Context

```
            ┌──────────────┐
  User ───▶ │   Obsidian   │──▶ vault notes (read / write via Obsidian APIs)
            │  + plugin    │──▶ OS keychain (SecretStorage)
            └──────┬───────┘
                   │ HTTPS: chat streamed via fetch (fallback
                   │ requestUrl()), everything else requestUrl()
   ┌───────────────┼───────────────────────┐
   ▼               ▼                       ▼
Anthropic API   OpenAI API              OpenAI auth
                (API key or             (auth.openai.com,
                 ChatGPT-plan token)     ChatGPT sign-in)
```

## External interfaces

| System | Endpoint | Used for | Auth |
|---|---|---|---|
| Anthropic | `POST https://api.anthropic.com/v1/messages` | Chat | `x-api-key`, `anthropic-version: 2023-06-01` |
| Anthropic | `GET https://api.anthropic.com/v1/models` (paginated) | Model list | same |
| OpenAI | `POST https://api.openai.com/v1/responses` | Chat | `Authorization: Bearer <API key>` |
| OpenAI | `GET https://api.openai.com/v1/models` | Model list | same |
| ChatGPT | `POST https://api.openai.com/v1/responses` | Chat on the user's ChatGPT plan | `Authorization: Bearer <ChatGPT-plan access token>` |
| ChatGPT | `GET https://api.openai.com/v1/models` | Model list for the account (`{models: [...]}`, kept if `visibility` is `list`) | same |
| OpenAI auth | `https://auth.openai.com/api/accounts/authorize` | Sign-in page, opened in the system browser | User's browser |
| OpenAI auth | `POST https://auth.openai.com/api/accounts/oauth/token` | Code exchange and refresh | Issued client ID, PKCE verifier or refresh token; no secret |
| OpenAI auth | `POST https://auth.openai.com/api/accounts/oauth/revoke` | Sign-out (revokes the refresh token) | Issued client ID |
| OpenAI | `POST https://api.openai.com/v1/live/sessions` | Voice: create a GPT-Live session (WebRTC offer in, answer out) | `Authorization: Bearer <API key>` |
| OpenAI | WebRTC (audio both ways, `oai-events` data channel) | Voice conversation | the session created above |
| Codex (private builds only, ADR-14) | `POST https://chatgpt.com/backend-api/codex/realtime/calls`; device code, token and refresh at `auth.openai.com` | Voice on the ChatGPT plan, unofficial | Codex sign-in token, `ChatGPT-Account-ID` |
| Loopback | `http://127.0.0.1:<port>/auth/callback` | Where the sign-in lands; nothing listens there, the user copies the address | none |

Web search runs on the provider's side (Anthropic and OpenAI
`web_search`); the plugin only enables the tool.

## Scope

- **In scope:** chat in a side panel, vault tools, three providers, model
  lists, ChatGPT sign-in, live voice (OpenAI GPT-Live).
- **Out of scope:** vault indexing or embeddings, background work, local
  models, other providers (ADR-06, ADR-07).
