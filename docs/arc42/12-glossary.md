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
| Continue | The action offered for a turn cut off when Obsidian was ended mid-turn: its conversation still carries the pending-turn marker (`pendingTurn`) and the model owes an answer; Continue finishes the turn from the saved history (`AgentLoop.continueTurn()`). Never automatic. |
| Delegation | In a voice conversation, the voice model handing a request to the plugin, which runs it as a chat turn and returns the answer to speak. |
| Dialect | One of the two voice event formats on the data channel: GPT-Live's `session.*` events or Codex's (`delegation.created`, …). Parsed both ways in `src/voice/protocol.ts`. |
| GPT-Live | OpenAI's speech-to-speech model for voice apps (`gpt-live-1`), used over WebRTC. |
| Issued client ID | The `oaiapp_…` client ID OpenAI issues at the first ChatGPT sign-in (started with `dynamic_agent_client`); reused for later sign-ins, refresh and sign-out. |
| Lifecycle hint | An event that suggests Obsidian went to or came back from the background (document `visibilitychange`, Capacitor `pause`/`resume`, window `focus`, `pageshow`); read by `src/platform/lifecycle.ts`. |
| Model catalog | A provider's list of models with their capabilities, loaded from its API and cached for 24 hours. |
| Pending turn | See Continue. |
| PKCE | Proof Key for Code Exchange: the sign-in sends a hash of a one-time secret, the code exchange the secret itself, so a stolen code is useless. |
| Private build | A build with `__CODEX_VOICE__` true (`npm run build:private`, `npm run dev`): includes the unofficial Codex voice route. Never released. |
| Provider | One of `anthropic`, `openai`, `chatgpt-oauth`. |
| `requestUrl()` | Obsidian's HTTP function; works around CORS on mobile and returns complete responses only. |
| Responses API | OpenAI's `/v1/responses` API, used by the OpenAI provider (API key) and the ChatGPT provider (ChatGPT-plan token). |
| Resume | Sending a request again, in the same turn, after it failed or stalled while the app was in the background; shown as "Resuming…" (`onResuming`). |
| `SecretStorage` | Obsidian's API for storing secrets in the OS keychain. |
| Selection scope | Mode where the user's selected text is sent with the message and edits must stay inside it. |
| Sign in with ChatGPT | OpenAI's OAuth sign-in that lets an app use the user's ChatGPT plan on `api.openai.com/v1` (preview for open-source apps). |
| SSE | Server-Sent Events: the `event:`/`data:` text format in which providers stream answers; parsed in `src/api/stream.ts`. |
| Steering | Adding a request to a running turn instead of stopping it; it goes out with the loop's next request (`AgentLoop.steer()`). Used by voice. |
| Text delta | A piece of answer text from a stream, shown as it arrives (`onTextDelta`). |
| Thinking level | How much a model reasons before answering (provider names: effort, reasoning effort). |
| Tool | A function the model may call, declared in `src/tools/registry.ts` and run by `src/tools/executor.ts`. |
| Unified message | The provider-neutral message format (`UnifiedMessage` in `src/types.ts`) the agent loop works with. |
| Voice route | How a voice call is created: the official one with an OpenAI API key, or the Codex one in private builds (`main.voiceRoute()`). |
