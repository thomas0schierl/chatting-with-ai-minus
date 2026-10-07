# 4. Solution strategy

> **Belongs here:** the few core ideas that shape the whole design, each in
> a line or two. **Elsewhere:** the reasoning behind each choice
> (→ [9](09-architecture-decisions.md)), how the parts fit together
> (→ [5](05-building-block-view.md)).

| Goal | Approach |
|---|---|
| Mobile parity | One code path for all platforms: `requestUrl()` for HTTP, except streamed chat (`fetch`, on desktop Node's `https`, both in `api/stream.ts`); no other Node APIs; ChatGPT sign-in by pasting the callback address. |
| Answers as they're written | Chat requests stream through one transport module with `fetch`; if `fetch` is blocked, the same request goes through `requestUrl()` and the answer appears when complete (ADR-12). |
| Simplicity | One plugin bundle, one Svelte component for the chat UI, one agent loop for all providers, three providers only. |
| Provider independence | A unified message format; one small adapter per provider converts it to and from the provider's API. |
| Agentic vault work | The model acts only through declared tools that call Obsidian's vault APIs; the loop runs tools and resends until the model stops. |
| Safe user data | Credentials only in `SecretStorage`; settings in `data.json`; chat history in a separate local file. |
| Provider resilience | Model lists and their capabilities come from each provider's API and are cached for 24 hours; only fallback defaults are built in. |
| Voice like the chat apps | The voice model only talks and delegates requests to the same agent loop, so voice and typed turns share tools and history (ADR-11). An unofficial Codex route on the ChatGPT plan is off by default and used at the user's own risk (ADR-14). |
| Phones that suspend apps | Nothing runs in the background; on the return the plugin recovers: resends a failed request, offers Continue for a turn cut off, reconnects voice (ADR-15). |
| Low cost per turn | The system prompt never changes, so providers can cache it; per-turn context (active note, selection) goes into the user message. |
