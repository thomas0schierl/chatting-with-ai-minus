# 11. Risks and technical debt

> **Belongs here:** known risks and known gaps in the current code, as an
> index. Each debt item has its own file in
> [11-technical-debt/](11-technical-debt/): the title, one sentence
> describing the problem, then **Where**, **Impact**, **Problem** and
> **Fix**. Delete an item's file when it is fixed (git keeps the history).
> **Elsewhere:** decisions (→ [9](09-architecture-decisions.md)), feature
> ideas that aren't flaws (→ issues).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| OpenAI changes or closes the Codex backend for third-party clients | ChatGPT sign-in stops working | API-key providers stay available; errors point to them. |
| OpenAI objects to the plugin identifying as the Codex CLI | Provider removal, possible plugin delisting | Accepted when publishing (ADR-03); be ready to drop the provider. |
| Provider APIs change request or response formats | Errors until fixed | Offline regression tests; live checks before releases ([10](10-quality-requirements.md)). |
| Upstream fixes don't reach the fork automatically | Bugs fixed upstream stay here | Review upstream changes now and then; port what fits. |

## Technical debt

| ID | Item | Impact |
|---|---|---|
| [TD-003](11-technical-debt/003-custom-model-saves-empty-model.md) | "Custom..." saves an empty model | Low |
| [TD-006](11-technical-debt/006-thinking-level-not-configurable.md) | Thinking level can't be set and is partly guessed from model names | Medium |
| [TD-007](11-technical-debt/007-chat-history-wiped-on-early-unload.md) | Chat history can be wiped when the plugin unloads early | Medium |
| [TD-008](11-technical-debt/008-single-conversation-only.md) | Only one conversation | Medium |
| [TD-009](11-technical-debt/009-math-not-rendered.md) | Math in answers isn't rendered | Low–medium |
| [TD-010](11-technical-debt/010-answer-scrolls-question-away.md) | New answers scroll the question out of view | Medium (mobile) |
| [TD-011](11-technical-debt/011-images-saved-twice.md) | Saved chat history stores every image twice | Medium |
| [TD-012](11-technical-debt/012-publishing-tooling.md) | No Obsidian lint rules or automated releases | Medium (publishing) |

Numbers are kept from the gap analysis. 001, 004 and 005 were fixed
upstream before the fork (stale ChatGPT model list, reasoning guessed from
model names, failing follow-up messages). 002 (settings rewritten on every
load) went away with the legacy migration code (ADR-09).

## To investigate

Found while reading the code, not yet confirmed. Confirm, then turn into a
debt item or drop.

- Stop during `ask_user` may leave the pending answer open, so the next
  message would answer the stopped run instead of starting a new one.
- Anthropic web search results are read from `search_results`, which may
  not match the API's response shape.
- Codex: no refresh-and-retry after a 401; parallel token refreshes aren't
  merged.
- Device login polling has no overall timeout.
- Restored tool cards lose their inputs (saved as `{}`).
- Stale comments: `tools/registry.ts` says 9 tools, and
  `ChatContainer.svelte` mentions a `chat-modal.ts` that doesn't exist.
