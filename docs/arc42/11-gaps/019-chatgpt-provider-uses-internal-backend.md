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

## The catch, and how to work around it

The official sign-in redirects to a loopback callback on `127.0.0.1`.
Mobile apps can't run a server there. But the server isn't needed to
finish the sign-in:

- **The redirect URL carries the result:** `code`, `state` and the issued
  `client_id` are all in it. The token exchange is a separate request the
  plugin makes itself.
- **The port is the app's choice and needs no registration** ("only the
  port may vary").
- **On mobile:** the browser shows "can't connect" on the callback page,
  but its address bar holds the full URL. The user copies it into the
  plugin, and the plugin checks `state` and exchanges the code through
  `requestUrl()`.
- **On desktop:** a small loopback server (Node `http`, available in
  Electron) can catch the redirect automatically.

The paste step isn't described in the docs, but nothing in them forbids
it. Each device signs in separately.

## Options

1. **Keep the current route:** accept the risk (today's ADR-03).
2. **Official route everywhere:**
   - Sign-in by pasting the callback URL (all platforms), with automatic
     capture on desktop as a later convenience.
   - Inference on `api.openai.com/v1/responses`, which also allows
     streaming (ADR-12).
   - Costs: a clunkier login than today's device code, and the programme
     is a preview.
3. **Wait** for a device flow on the official route.

## Fix

- Recommended: option 2.
- Confirm the paste flow once on a phone, then record it as an ADR
  replacing ADR-02 and ADR-03.
- Keep the current route until the new one is proven.
- Sources:
  - [Sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md)
  - [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md)
  - [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md)
