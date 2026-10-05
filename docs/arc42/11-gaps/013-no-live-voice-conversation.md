# GAP-013: No live voice conversation

Users can only type; there is no voice mode like in the ChatGPT, Claude or
Codex apps, where you talk, hear the answer and can interrupt.

- **Where:** new: a voice button in the chat input (`ui/ChatContainer.svelte`),
  a voice module (e.g. `src/voice/`), the tool loop (`agent/loop.ts`),
  a new runtime flow in [§6](../06-runtime-view.md)
- **Impact:** high (most-wanted feature, especially on phones); large effort

## Problem

There is no microphone input or spoken output. ADR-01 (all HTTP through
`requestUrl()`, no streaming) also rules out the streaming audio that live
voice needs, so this feature needs a new ADR.

## Options

**A. Live speech-to-speech (like ChatGPT voice)**

- **Service:** the OpenAI Realtime API (`gpt-realtime-*` models), connected
  over WebRTC from the browser.
- **Setup:**
  1. The plugin gets a short-lived client secret with
     `POST /v1/realtime/client_secrets`, using `requestUrl()` and the API
     key.
  2. It exchanges the WebRTC offer at `/v1/realtime/calls`.
  3. Audio then flows directly between the device and OpenAI.
- **What it supports:** voice activity detection, interrupting the model
  (barge-in), function calling (so the vault tools can run as today), and
  text transcripts of both sides that can be saved into the chat history.
- **Providers:**
  - **OpenAI API key:** yes.
  - **ChatGPT sign-in:** possible but unverified. Codex CLI 0.156 (Sept
    2026) has a `/voice` live conversation using the ChatGPT login, and
    third-party tools mint Realtime client secrets from a Codex login. The
    exact endpoint and whether it is allowed for other clients must be
    checked in the Codex source.
  - **Anthropic:** no realtime audio API found; reportedly Claude's own
    voice mode uses speech-to-text and text-to-speech around the text model.

**B. Turn-based voice (works with every provider)**

- **Flow:** record → speech-to-text → the normal agent loop → text-to-speech
  → play.
- **Fit with ADR-01:** fits; everything is a complete request through
  `requestUrl()`.
- **Speech services:** for example OpenAI `/v1/audio/transcriptions` and
  `/v1/audio/speech` (API key), or the browser's Web Speech API, whose
  support in the mobile WebViews is uncertain.
- **Downsides:** slower to respond, no interrupting, and an extra speech
  service even for Anthropic users.

## Fix

1. **Spike** (blocks the rest):
   - Does microphone access (`getUserMedia`) work in Obsidian on iOS and
     Android?
   - Does WebRTC to OpenAI work from those WebViews?
   - Can the ChatGPT sign-in get a Realtime client secret?
2. **Decide and record an ADR:** A for OpenAI (and ChatGPT if the spike
   says yes), with B as the fallback for Anthropic, or B only if the spike
   fails on mobile.
3. **Keep voice and text in one conversation:** transcripts go into the
   chat history, and tool calls run through the same executor and are
   shown as tool cards.
4. **Limits:** voice only runs while the chat panel is open. A plugin
   can't keep the microphone running in the background or on the lock
   screen.

## Sources

- [OpenAI: Realtime API guide](https://developers.openai.com/api/docs/guides/realtime)
- [Fora Soft: OpenAI Realtime API with WebRTC in 2026](https://www.forasoft.com/blog/article/openai-realtime-api-webrtc-sip-websockets-integration)
  (endpoint changes)
- [Spokenly: Codex voice mode](https://spokenly.app/blog/voice-dictation-for-developers/codex)
  (Codex CLI 0.156 `/voice`)
- [gods-eye-view #653](https://github.com/bilawalsidhu/gods-eye-view/pull/653)
  (Realtime secrets from a Codex login)
- [Claudexia: Claude voice stack 2026](https://claudexia.tech/blog/claude-voice-realtime-stack-2026)
  (no Claude realtime audio API)
