# GAP-019: The ChatGPT provider uses Codex's internal backend

The plugin signs in as the Codex CLI and talks to
`chatgpt.com/backend-api/codex/*`, an internal route. OpenAI now offers an
official, sanctioned route for open-source apps.

- **Where:** `auth/chatgptOAuth.ts`, `api/chatgpt-oauth.ts`,
  `api/model-catalog.ts`, ADR-02, ADR-03
- **Impact:** high risk (the provider can be blocked, and the plugin
  delisted); medium effort

## Problem

- **What the plugin does today:**
  - Uses the Codex CLI's OAuth client ID (`app_EMoamEEZ73f0CkXaXp7hrann`).
  - Sends the Codex `originator` header.
  - Calls the Codex backend.
- **OpenAI's position:** the official "Sign in with ChatGPT" preview tells
  apps not to reuse another app's client ID and not to call `backend-api`
  endpoints.
- **Browser access:** the Codex backend doesn't allow browser (CORS)
  requests, so this provider can never stream (ADR-12).

## The official route (verified 2026-10-05)

- **Sign-in:**
  - Authorization at `https://auth.openai.com/api/accounts/authorize`
    with PKCE.
  - First sign-in uses `client_id=dynamic_agent_client`; the response
    issues an app client ID (`oaiapp_…`) to keep.
  - Scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`.
  - A persistent `ext_agent_host_id` per installation.
- **Callback:** a browser redirect back to an HTTP loopback callback on
  `127.0.0.1`.
- **Inference:** `POST https://api.openai.com/v1/responses` with
  `Authorization: Bearer <token>`, `store: false`, `stream: true`.
  - Models from `GET /v1/models`, keeping those with `visibility == "list"`.
  - `api.openai.com` allows browser requests, so streaming with `fetch`
    would work.
- **Excluded:** audio and video input, file uploads, transcription,
  hosted tools such as file search and Code Interpreter.

## The catch

The official sign-in needs a loopback HTTP server for the redirect. Mobile
can't run one, which is why ADR-02 chose the device flow. No device flow is
documented for the official route.

## Options

1. **Keep the current route:** accept the risk (today's ADR-03).
2. **Official route on desktop:**
   - Sign in on desktop with a small loopback server (Node `http`,
     desktop only).
   - Use the same flow for inference everywhere.
   - Mobile can't sign in with it, unless tokens can move from desktop
     to phone, which SecretStorage doesn't sync.
3. **Ask OpenAI or wait:** a device flow for the official route would
   solve it for all platforms.

## Fix

- Decide between 1 and 2, and record it as an ADR replacing ADR-03.
- Meanwhile, watch the preview docs for a device flow.
- Sources:
  - [Sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md)
  - [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md)
  - [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md)
