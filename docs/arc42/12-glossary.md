# 12. Glossary

> **Belongs here:** terms that have a specific meaning in this project, one
> line each, alphabetical. **Elsewhere:** explanations of how things work
> (→ the section that describes them).

| Term | Meaning |
|---|---|
| Adapter | Code that converts the unified message format to one provider's API and back (`src/api/anthropic.ts`, `openai.ts`, `chatgpt-oauth.ts`). |
| Agent loop | The cycle send → run requested tools → send results → … until the model stops (`src/agent/loop.ts`). |
| `client_version` | The Codex CLI version the plugin reports to the Codex backend; it decides which models the backend lists. |
| Codex backend | `chatgpt.com/backend-api/codex/*`, the API the Codex CLI uses with a ChatGPT sign-in. Not the public OpenAI API. |
| Device Authorization Flow | OAuth login where the user enters a short code on a web page instead of being redirected back to the app. |
| Model catalog | A provider's list of models with their capabilities, loaded from its API and cached for 24 hours. |
| Provider | One of `anthropic`, `openai`, `chatgpt-oauth`. |
| `requestUrl()` | Obsidian's HTTP function; works around CORS on mobile and returns complete responses only. |
| Responses API | OpenAI's `/v1/responses` API, also used (with changes) by the Codex backend. |
| `SecretStorage` | Obsidian's API for storing secrets in the OS keychain. |
| Selection scope | Mode where the user's selected text is sent with the message and edits must stay inside it. |
| Thinking level | How much a model reasons before answering (provider names: effort, reasoning effort). |
| Tool | A function the model may call, declared in `src/tools/registry.ts` and run by `src/tools/executor.ts`. |
| Unified message | The provider-neutral message format (`UnifiedMessage` in `src/types.ts`) the agent loop works with. |
