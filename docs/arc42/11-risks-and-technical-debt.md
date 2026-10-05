# 11. Risks and technical debt

> **Belongs here:** known risks, and known gaps as an index. Gaps are flaws
> in the current code (debt) or features users expect from comparable AI
> apps that are missing. Each gap has its own file in `11-gaps/` (created with the first open gap):
> the title, one sentence describing the gap, then **Where**, **Impact**,
> **Problem** and **Fix**. Delete a gap's file when it's closed (git keeps
> the history). **Elsewhere:** decisions (→ [9](09-architecture-decisions.md)),
> small one-off ideas (→ issues).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| OpenAI changes or ends the "Sign in with ChatGPT" preview | ChatGPT sign-in breaks until updated | API-key providers stay available; errors point to them. |
| OpenAI objects to signing in by pasting the callback address (not described in its docs) | ChatGPT sign-in on mobile stops working | Desktop could catch the callback with a loopback server; watch for a device flow. |
| Provider APIs change request or response formats | Errors until fixed | Offline regression tests; live checks before releases ([10](10-quality-requirements.md)). |
| OpenAI changes or blocks Codex's internal voice route, or objects to its use (private builds only, ADR-14) | Codex voice stops working | Opt-in and labelled unofficial; the official route with an API key stays available. |
| Upstream fixes don't reach the fork automatically | Bugs fixed upstream stay here | Review upstream changes now and then (o1xhack/obsidian-chatting and its origin omarshahine/obsidian-chat); port what fits. |

## Gaps

None open (GAP-013, live voice, was closed with ADR-11; what's left to
check is under *To investigate*).

Numbers are kept from the first gap analysis. 001, 004 and 005 were fixed
upstream before the fork (stale ChatGPT model list, reasoning guessed from
model names, failing follow-up messages). 002 (settings rewritten on every
load) went away with the legacy migration code (ADR-09). 003 and 006–021
were fixed in the fork.

## To investigate

Found while reading the code, not yet confirmed. Confirm, then turn into a
gap or drop.

- OpenAI: requests no longer ask for encrypted reasoning (`include`), so a
  full history replay relies on OpenAI having stored the reasoning items.
  Check live after a model change or restart.
- All conversations, image data included, live in one `chat-state.json`
  that is rewritten after every turn; check size and save time with many
  chats with images (saving attachments as separate files would fix it).
- Switching conversations stops a running turn; it can't finish in the
  background. The conversation list has no search.
- `view_canvas` shows note file nodes by name only, and very large canvases
  are hard to read when fitted.
- ChatGPT: whether `function_call_output` may contain `input_image` is
  assumed from the general "images are supported" note; check live.
- Streaming: unverified in the mobile apps (run *Check device
  capabilities*), including whether a CORS block there fails as a
  `TypeError` (only then is `fetch` skipped for 10 minutes). A stopped
  partial answer isn't sent to the model next turn.
- ChatGPT model list: depends on the undocumented `client_version`
  parameter (without it, newer models are hidden).
- Message editing: no Retry after a turn that failed without any answer
  (editing and saving it unchanged works); images can't be added or
  removed while editing; chats saved before turn IDs existed are paired
  from the end, which can be off by one if a turn failed before reaching
  the API history.
- Canvas placement (`edit_canvas`) avoids other cards but not edge paths
  or the label above a group. A group that grows can overlap its
  neighbours, and moving a card out of a group doesn't shrink the group.
- Voice (ADR-11) is built but not yet tried live: check with an API key
  (*Check device capabilities* starts and closes one session) that
  `gpt-live-1` answers, delegations arrive, the answer is spoken and
  the end closes cleanly (`debug.log` with `DEBUG` on shows every event).
  In the iOS and Android apps: WebRTC, the microphone prompt and a
  denial, autoplay, earpiece vs speaker, echo causing false interruptions
  on speaker, screen lock.
- Voice: small talk the voice model handles itself appears only in the
  live caption, not in the chat history. GPT-Live's delegation carries no
  text; the request is the transcript since the last delegation, which
  may be cut or include words that weren't meant for it.
- Back from the background (ADR-15), on iOS and Android: leave the app
  for 10 s and for 60 s during a streamed answer, during a turn with a
  tool call, and during voice; check that the answer continues
  ("Resuming…") without duplicated text, that voice comes back
  ("Reconnecting…") or has ended after 60 s, and, after iOS ended the
  app, that Continue appears and finishes the turn. With `DEBUG` on,
  `debug.log` shows each hint (`LIFECYCLE`) and each resend
  (`API_RESUME`): check whether `pause`/`resume` fire (or only
  `visibilitychange`), and how long iOS lets an open request finish in
  the background.
- Codex voice route (private builds): checked on desktop 2026-10-05.
  The data channel carries Codex's dialect (`delegation.created` with
  the request text, `input_transcript.added`, `turn.done`, …) and
  acknowledges `delegation.context.append`; two requests ran on the
  ChatGPT plan with vault tools and were spoken. Not yet checked in the
  mobile apps.
