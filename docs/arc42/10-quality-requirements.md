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
| Q-04 | Safe user data | After restarting Obsidian, the conversation, the chosen model and settings are unchanged. | Manual, each release |
| Q-05 | Safe user data | An edit with selection scope changes only text inside the selection. | `npm test` |
| Q-06 | Provider resilience | A model added by a provider appears in the model list within 24 hours, without a plugin update. | `npm test` (catalog); manual |
| Q-07 | Provider resilience | A rejected model or request shows the provider's error message and a way forward. | Manual |
| Q-08 | Simplicity | A new contributor finds where a change belongs from `docs/arc42/` alone. | Review |

## Live checks before a release

The offline tests (`npm test`) mock all providers. Before a release,
check against the real services and note the result in the release notes:

- For each provider: a plain message, a follow-up message, and a turn that
  reads one note and creates another.
- For ChatGPT: the model list loads for the signed-in account and the
  default model answers.
- On a physical phone: Q-01 and Q-02.

A model being in the list doesn't prove the account may use it; only a
successful request does.
