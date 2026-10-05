# GAP-013: No live voice conversation

Users can only type; there is no voice mode like in the ChatGPT, Claude or
Codex apps, where you talk, hear the answer and can interrupt.

- **Where:** new: a voice button in the chat input (`ui/ChatContainer.svelte`),
  a voice module (e.g. `src/voice/`), the agent loop (`agent/loop.ts`),
  a new runtime flow in [§6](../06-runtime-view.md)
- **Impact:** high (most-wanted feature, especially on phones); large effort

## Decided so far ([ADR-11](../09-architecture-decisions.md))

Live speech-to-speech over WebRTC with OpenAI, setup calls through
`requestUrl()`. **Voice needs an OpenAI API key:**

- **ChatGPT sign-in:** Codex's own `/voice` uses an internal route.
  - It creates the call at `chatgpt.com/backend-api/codex/realtime/calls`.
  - It receives events over a separate WebSocket that needs
    `Authorization` headers, which browsers can't set on a WebSocket.
  - It's unofficial, and OpenAI's official "Sign in with ChatGPT" route
    excludes audio.
- **Anthropic:** has no speech-to-speech API.

## Open: which OpenAI API

| | Realtime API | GPT-Live |
|---|---|---|
| Setup | `POST /v1/realtime/client_secrets`, then `POST /v1/realtime/calls` (SDP) | `POST /v1/live/sessions` (SDP in the JSON body) |
| Who does the work | The voice model itself calls our vault tools (function calling in the session) | The voice model talks; tasks are handed over ("delegation") to our client, which runs the normal agent loop and returns text to speak |
| The "brain" | `gpt-realtime-2.1` | The user's chosen chat model, any provider |
| Status | Documented and supported | OpenAI's recommendation for new voice apps |
| Billing | Per token | Per second; WebRTC start bills 15 s up front |

**Recommendation: GPT-Live with client delegation.**
- **One agent, one conversation:** voice and text share the agent, tools
  and history. The thinking can use Anthropic or the ChatGPT plan; only the
  voice runs on OpenAI.
- **Check in the spike:** how delegation streams back.

## Verified request details (API key)

- **Ephemeral secret:** `POST https://api.openai.com/v1/realtime/client_secrets`
  returns `{value: "ek_…", expires_at, session}`.
  - It lives 600 s by default (10–7200 s via `expires_after`).
  - A session can last up to 60 min.
- **SDP:** `POST /v1/realtime/calls`.
  - **Two calls:** `Content-Type: application/sdp`, the offer as the body,
    and the answer SDP back as text.
  - **One call:** a multipart `sdp` + `session` body with the API key. We'd
    build the multipart body by hand, since `requestUrl()` has no FormData.
- **Data channel `oai-events`:** create it before the offer.
  - **Transcripts:** `conversation.item.input_audio_transcription.*` (user)
    and `response.output_audio_transcript.*` (assistant).
  - **Function calls:** `response.function_call_arguments.done`; return
    `conversation.item.create` (`function_call_output`) and then
    `response.create`.
  - **Interruption:** with server voice detection, barge-in is automatic,
    and unplayed audio is truncated (`conversation.item.truncated`).
- **GPT-Live:** `POST /v1/live/sessions` with
  `{session: {model: "gpt-live-1", instructions, delegation}, transport: {type: "webrtc", sdp}}`
  returns 201 with the answer SDP.
  - Events: `session.input_transcript.delta`,
    `session.output_transcript.delta`, `session.delegation.created`.

## Fix

1. **Spike on the devices**, with a hidden dev command that opens a voice
   session. Check:
   - **WebRTC in the Obsidian apps:** does `RTCPeerConnection` exist and
     connect inside Obsidian on iOS and Android? No evidence either way
     yet.
   - **Microphone:** `getUserMedia` works on both; the core audio recorder
     and other plugins use it. Check the first-use prompt and what happens
     after a denial.
   - **Audio:** autoplay of the remote audio, earpiece vs speaker on iOS,
     and echo causing false barge-in on speaker.
   - **`requestUrl()`:** does it pass `application/sdp` and hand-built
     multipart bodies through, and does it expose the `Location` header?
   - **Desktop:** Electron's permission handler and the OS microphone
     prompt.
   - **Account access:** whether the models are available on a normal API
     account.
2. **Choose:** Realtime or GPT-Live from the spike, and add the result to
   ADR-11.
3. **Build:**
   - A voice button.
   - The session module.
   - Transcripts into the chat history, and tool cards as in text chat.
4. **Limits:** voice only while the chat panel is open; iOS stops on screen
   lock.

## Sources

- **OpenAI:**
  - [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc.md)
  - [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations.md)
  - [client_secrets](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create.md)
  - [calls](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create.md)
  - [GPT-Live](https://developers.openai.com/api/docs/guides/live.md)
  - [Live delegation](https://developers.openai.com/api/docs/guides/live-delegation.md)
- **Official "Sign in with ChatGPT" limits:**
  [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md)
- **Codex source** (`openai/codex`, 2026-10-05):
  - `codex-rs/codex-api/src/endpoint/realtime_call.rs`
  - `codex-rs/core/src/realtime_conversation.rs`
  - `codex-rs/voice-host/src/transport.rs`
- **Obsidian microphone:**
  - [Audio recorder](https://obsidian.md/help/Plugins/Audio+recorder)
  - [iOS 26 recording issue](https://forum.obsidian.md/t/ios26-audio-recording-core-plugin-is-not-working-properly/106161)
  - [background recording](https://forum.obsidian.md/t/mobile-ios-support-audio-recording-during-sleep-background/86231)
