# 11. Risks and technical debt

> **Belongs here:** known risks, and known gaps as an index. Gaps are flaws
> in the current code (debt) or features users expect from comparable AI
> apps that are missing. Each gap has its own file in [11-gaps/](11-gaps/):
> the title, one sentence describing the gap, then **Where**, **Impact**,
> **Problem** and **Fix**. Delete a gap's file when it's closed (git keeps
> the history). **Elsewhere:** decisions (→ [9](09-architecture-decisions.md)),
> small one-off ideas (→ issues).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| OpenAI changes or closes the Codex backend for third-party clients | ChatGPT sign-in stops working | API-key providers stay available; errors point to them. |
| OpenAI objects to the plugin identifying as the Codex CLI | Provider removal, possible plugin delisting | Accepted for now (ADR-03); an official route exists but needs a desktop-only sign-in ([GAP-019](11-gaps/019-chatgpt-provider-uses-internal-backend.md)). |
| Provider APIs change request or response formats | Errors until fixed | Offline regression tests; live checks before releases ([10](10-quality-requirements.md)). |
| Upstream fixes don't reach the fork automatically | Bugs fixed upstream stay here | Review upstream changes now and then; port what fits. |

## Gaps

| ID | Gap | Kind | Impact |
|---|---|---|---|
| [GAP-008](11-gaps/008-single-conversation-only.md) | Only one conversation | Feature | Medium |
| [GAP-009](11-gaps/009-math-not-rendered.md) | Math in answers isn't rendered | Debt | Low–medium |
| [GAP-010](11-gaps/010-answer-scrolls-question-away.md) | New answers scroll the question out of view | Debt | Medium (mobile) |
| [GAP-011](11-gaps/011-images-saved-twice.md) | Saved chat history stores every image twice | Debt | Medium |
| [GAP-012](11-gaps/012-publishing-tooling.md) | No Obsidian lint rules or automated releases | Debt | Medium (publishing) |
| [GAP-013](11-gaps/013-no-live-voice-conversation.md) | No live voice conversation | Feature | High |
| [GAP-014](11-gaps/014-edit-message-and-continue.md) | Can't edit an earlier message and continue from there | Feature | High |
| [GAP-015](11-gaps/015-no-message-actions.md) | No actions on single messages (copy, regenerate) | Feature | Medium |
| [GAP-016](11-gaps/016-answers-not-streamed.md) | Answers appear only when complete | Feature | High |
| [GAP-017](11-gaps/017-agent-cannot-see-images-or-canvases.md) | The agent can't look at images or canvases | Feature | Medium–high |
| [GAP-019](11-gaps/019-chatgpt-provider-uses-internal-backend.md) | The ChatGPT provider uses Codex's internal backend | Risk | High |

Numbers are kept from the first gap analysis. 001, 004 and 005 were fixed
upstream before the fork (stale ChatGPT model list, reasoning guessed from
model names, failing follow-up messages). 002 (settings rewritten on every
load) went away with the legacy migration code (ADR-09). 003, 006 and 007
were fixed in the fork.

## To investigate

Found while reading the code, not yet confirmed. Confirm, then turn into a
gap or drop.

- Stop during `ask_user` may leave the pending answer open, so the next
  message would answer the stopped run instead of starting a new one.
- Anthropic web search results are read from `search_results`, which may
  not match the API's response shape.
- Codex: no refresh-and-retry after a 401; parallel token refreshes aren't
  merged.
- Device login polling has no overall timeout.
- Restored tool cards lose their inputs (saved as `{}`).
- OpenAI: requests no longer ask for encrypted reasoning (`include`), so a
  full history replay relies on OpenAI having stored the reasoning items.
  Check live after a model change or restart.
- A corrupt `chat-state.json` is silently treated as empty and overwritten
  on the next save.
- Canvas placement (`edit_canvas`) avoids other cards but not edge paths
  or the label above a group. A group that grows can overlap its
  neighbours, and moving a card out of a group doesn't shrink the group.
- Stale comments: `tools/registry.ts` says 9 tools, and
  `ChatContainer.svelte` mentions a `chat-modal.ts` that doesn't exist.
