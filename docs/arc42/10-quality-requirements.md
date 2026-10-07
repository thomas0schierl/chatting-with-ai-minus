# 10. Quality requirements

> **Belongs here:** concrete, testable scenarios for the quality goals in
> [1](01-introduction-and-goals.md), and how they are checked.
> **Elsewhere:** known violations (→ [11](11-risks-and-technical-debt.md)).

## Scenarios

| ID | Goal | Scenario | Check |
|---|---|---|---|
| Q-01 | Mobile parity | A user on iOS sends a message that reads and edits a note; it behaves as on desktop. | Manual, physical iPhone, each release |
| Q-02 | Mobile parity | ChatGPT sign-in completes on a phone without a computer. | Manual, each change to `src/auth/` |
| Q-03 | Safe user data | After any action, `data.json` contains no API key or token. | `npm test`; code review |
| Q-04 | Safe user data | After restarting Obsidian, the conversations, the one that was open, the chosen model and settings are unchanged. | Manual, each release |
| Q-05 | Safe user data | An edit with selection scope changes only text inside the selection. | `npm test` |
| Q-06 | Provider resilience | A model added by a provider appears in the model list within 24 hours, without a plugin update. | `npm test` (catalog); manual |
| Q-07 | Provider resilience | A rejected model or request shows the provider's error message and a way forward. | Manual |
| Q-08 | Simplicity | A new contributor finds where a change belongs from `docs/arc42/` alone. | Review |
| Q-09 | Mobile parity | A long answer appears as it's written, on desktop and on a phone, and Stop ends it at once; where streaming is blocked, the answer still arrives whole. | `npm test` (stream parsing, fallback, Stop); manual, each release |

## Live checks before a release

The offline tests (`npm test`) mock all providers. Before a release,
check against the real services and note the result in the release notes:

- For each provider: a plain message, a follow-up message, and a turn that
  reads one note and creates another; a long answer streams, and Stop in
  the middle keeps the text shown so far (Q-09).
- For ChatGPT: the model list loads for the signed-in account and the
  default model answers.
- Files (ADR-17), for each provider: attach a PDF with a chart and a
  docx, xlsx and pptx, and ask about each; ask the AI to read a PDF from
  the vault (`read_file`). → Answers use the content (the chart from the
  PDF's page images); Anthropic answers from the Office text.
- Context and compaction (ADR-18), for each provider: the ring shows the
  window and (API keys) a cost close to the provider's usage page; lower
  the compaction point by choosing a model with a small window or a long
  chat, and check that the provider's compaction comes back (the note),
  the next answer still knows the earlier topic, and on ChatGPT whether
  the route accepts `context_management` (debug log). *Compact now*;
  switch provider after a compaction and ask about the earlier topic.
- Voice (OpenAI key): a question about a note is delegated, runs as a
  chat turn with tool cards, and the answer is spoken; End closes the
  session.
- On a physical phone: Q-01, Q-02 and Q-09, with the checklist below.

A model being in the list doesn't prove the account may use it; only a
successful request does.

### On a physical phone (iOS and Android)

Run on an iPhone and an Android phone. Expected results follow each step.

1. **Setup:** turn on *Debug log*, run *Check device capabilities*, copy
   the result. → Microphone, WebRTC and streaming `fetch` are listed with
   their outcome.
2. **Each provider:** ask for a long answer, then Stop one midway. → It
   streams (ChatGPT plan: arrives whole); Stop keeps the text shown.
3. **Message actions:** edit the last message (the pencil is visible on
   touch), Regenerate, Copy. → The turn runs again; Copy says "Copied".
4. **Conversations:** new, switch, rename (the keyboard opens), delete;
   restart Obsidian and open the chat. → The open conversation returns.
5. **Input bar:** → The slot shows voice when empty, send with text, stop
   while a turn runs; attach folds away while typing; focusing the input
   doesn't zoom; scrolled up, the jump-to-latest button shows; a
   streaming answer keeps the view at the bottom.
6. **Voice, both routes** (official with an OpenAI key; Codex with the
   ChatGPT plan): the microphone prompt, and a denial → error, then allowed in
   the system settings; hands-free and mute; hold to talk on touch; a
   question about a note → delegated, tool cards, spoken answer; a
   spoken addition while it works → added to the running task; an
   `ask_user` question answered by voice; End. Note earpiece or speaker,
   and echo causing false interruptions.
7. **Background:** leave the app for 10 s, 30 s and 60 s during a
   streamed answer, during a tool call and during voice. → "Resuming…"
   and no duplicated text; voice continues in the same call, shows
   "Reconnecting…", or has ended (after 60 s). Kill the app mid-turn
   (swipe it away), reopen. → **Continue** finishes the turn without
   running its tools again (iOS and Android).
8. **Log:** *Copy debug log*. → `LIFECYCLE` shows whether
   `pause`/`resume` fired (or only `visibilitychange`); `API_RESUME`
   shows each resend.
