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
| OpenAI changes or blocks Codex's internal voice route, or objects to its use (ADR-14) | Codex voice stops working; OpenAI may restrict or suspend the ChatGPT account used; Obsidian's reviewers may reject the plugin from the community directory | Off by default; choosing it needs a confirmed risk warning and its setting says it is at the user's own risk; the official route with an API key is the default. |
| Obsidian changes its search-match state or canvas internals (used to follow the AI's edits, `ui/show-in-view.ts`) | Edits are shown without highlight, or canvas cards aren't centered | The canvas API is checked before use and falls back to Obsidian's own select-and-pan; the match state is the one Obsidian's search uses. |
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
gap or drop. Phone behaviour is checked with the
[phone checklist](10-quality-requirements.md#on-a-physical-phone-ios-and-android);
only its open questions are listed here.

- OpenAI: requests no longer ask for encrypted reasoning (`include`), so a
  full history replay relies on OpenAI having stored the reasoning items.
  Check live after a model change or restart.
- All conversations, image data included, live in one `chat-state.json`
  that is rewritten after every turn; check size and save time with many
  chats with images (saving attachments as separate files would fix it).
- The conversation list has no search.
- Compaction (ADR-18): whether the ChatGPT route accepts
  `context_management` (not in its documented fields; refused, the plugin
  summarizes itself); Anthropic's threshold compaction is a beta; prices
  and OpenAI's windows are read from documentation pages whose format may
  change. Check live.
- `view_canvas` shows note file nodes by name only, and very large canvases
  are hard to read when fitted.
- ChatGPT: whether `function_call_output` may contain `input_image` is
  assumed from the general "images are supported" note; check live.
- Streaming in the mobile apps: whether a CORS block there fails as a
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
- Official voice route (ADR-11): not yet tried live end to end with an
  API key (§10 live checks; *Check device capabilities* starts and closes
  one session). On phones: autoplay, earpiece or speaker, echo causing
  false interruptions on speaker, screen lock.
- Voice: small talk the voice model handles itself is only heard; it
  isn't written anywhere (the voice bar shows only the user's words). GPT-Live's delegation carries no
  text; the request is the transcript since the last delegation, which
  may be cut or include words that weren't meant for it.
- Back from the background (ADR-15): whether `pause`/`resume` fire on
  iOS and Android (or only `visibilitychange`), and how long iOS lets an
  open request finish in the background.
