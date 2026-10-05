# 12. Glossary

> **Belongs here:** terms that have a specific meaning in this project, one
> line each, alphabetical. **Elsewhere:** explanations of how things work
> (→ the section that describes them).

| Term | Meaning |
|---|---|
| Adapter | Code that converts the unified message format to one provider's API and back (`src/api/anthropic.ts`, `openai.ts`, `chatgpt-oauth.ts`). |
| Agent host ID | `ext_agent_host_id`: a random `urn:uuid:` ID per device, sent at every ChatGPT sign-in so OpenAI can tell the user's devices apart. Not a secret. |
| Agent loop | The cycle send → run requested tools → send results → … until the model stops (`src/agent/loop.ts`). |
| Callback address | The `http://127.0.0.1:<port>/auth/callback?code=…` address the browser lands on after the ChatGPT sign-in; the user pastes it into the plugin. |
| Issued client ID | The `oaiapp_…` client ID OpenAI issues at the first ChatGPT sign-in (started with `dynamic_agent_client`); reused for later sign-ins, refresh and sign-out. |
| Model catalog | A provider's list of models with their capabilities, loaded from its API and cached for 24 hours. |
| PKCE | Proof Key for Code Exchange: the sign-in sends a hash of a one-time secret, the code exchange the secret itself, so a stolen code is useless. |
| Provider | One of `anthropic`, `openai`, `chatgpt-oauth`. |
| `requestUrl()` | Obsidian's HTTP function; works around CORS on mobile and returns complete responses only. |
| Responses API | OpenAI's `/v1/responses` API, used by the OpenAI provider (API key) and the ChatGPT provider (ChatGPT-plan token). |
| `SecretStorage` | Obsidian's API for storing secrets in the OS keychain. |
| Selection scope | Mode where the user's selected text is sent with the message and edits must stay inside it. |
| Sign in with ChatGPT | OpenAI's OAuth sign-in that lets an app use the user's ChatGPT plan on `api.openai.com/v1` (preview for open-source apps). |
| Thinking level | How much a model reasons before answering (provider names: effort, reasoning effort). |
| Tool | A function the model may call, declared in `src/tools/registry.ts` and run by `src/tools/executor.ts`. |
| Unified message | The provider-neutral message format (`UnifiedMessage` in `src/types.ts`) the agent loop works with. |
