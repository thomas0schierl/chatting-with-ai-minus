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
                   │ HTTPS via requestUrl()
   ┌───────────────┼──────────────────────────┬──────────────────┐
   ▼               ▼                          ▼                  ▼
Anthropic API   OpenAI API        ChatGPT / Codex backend    GitHub API
                                  + auth.openai.com          (Codex version)
```

## External interfaces

| System | Endpoint | Used for | Auth |
|---|---|---|---|
| Anthropic | `POST https://api.anthropic.com/v1/messages` | Chat | `x-api-key`, `anthropic-version: 2023-06-01` |
| Anthropic | `GET https://api.anthropic.com/v1/models` (paginated) | Model list | same |
| OpenAI | `POST https://api.openai.com/v1/responses` | Chat | `Authorization: Bearer <API key>` |
| OpenAI | `GET https://api.openai.com/v1/models` | Model list | same |
| ChatGPT / Codex | `POST https://chatgpt.com/backend-api/codex/responses` | Chat | OAuth bearer token, `ChatGPT-Account-Id`, `originator`, `version` |
| ChatGPT / Codex | `GET https://chatgpt.com/backend-api/codex/models?client_version=…` | Model list for the account | same |
| OpenAI auth | `POST https://auth.openai.com/api/accounts/deviceauth/usercode`, `…/deviceauth/token`, `…/oauth/token` | Device login, token exchange and refresh | Client ID (+ device code / refresh token) |
| OpenAI auth | `https://auth.openai.com/codex/device` | Page the user opens to enter the login code | User's browser |
| GitHub | `GET https://api.github.com/repos/openai/codex/releases/latest` | Current stable Codex CLI version, sent as `client_version` | none |

Web search runs on the provider's side (Anthropic `web_search`, OpenAI and
Codex `web_search`); the plugin only enables the tool.

## Scope

- **In scope:** chat in a side panel, vault tools, three providers, model
  lists, ChatGPT sign-in.
- **Out of scope:** vault indexing or embeddings, background work, local
  models, other providers (ADR-06, ADR-07).
