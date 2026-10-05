# Documentation map

> **Belongs here:** which document holds what, so every fact has one home.
> **Elsewhere:** the content itself.

| Document | Holds |
|---|---|
| [README.md](../README.md) | For users: features, commands, install, setup, use on a phone, troubleshooting, privacy. |
| [AGENTS.md](../AGENTS.md) | For developers and coding agents: commands, rules, where to look. `CLAUDE.md` only imports it. |
| [test/README.md](../test/README.md) | How to run the tests. |
| [arc42/](arc42/) | The architecture, in the 12 arc42 sections below. |

## arc42 sections

| Section | Holds |
|---|---|
| [1 Introduction and goals](arc42/01-introduction-and-goals.md) | Purpose, features, quality goals, stakeholders |
| [2 Constraints](arc42/02-constraints.md) | Limits we can't choose |
| [3 Context and scope](arc42/03-context-and-scope.md) | Users and external systems the plugin talks to |
| [4 Solution strategy](arc42/04-solution-strategy.md) | The core design ideas, briefly |
| [5 Building block view](arc42/05-building-block-view.md) | Modules and their responsibilities |
| [6 Runtime view](arc42/06-runtime-view.md) | Important flows step by step |
| [7 Deployment view](arc42/07-deployment-view.md) | Build, release, install, runtime files |
| [8 Crosscutting concepts](arc42/08-crosscutting-concepts.md) | Rules that apply everywhere (persistence, errors, mobile, security) |
| [9 Architecture decisions](arc42/09-architecture-decisions.md) | Decisions with context and consequences (ADRs) |
| [10 Quality requirements](arc42/10-quality-requirements.md) | Testable quality scenarios, release checks |
| [11 Risks and technical debt](arc42/11-risks-and-technical-debt.md) | Risks, and one file per known gap |
| [12 Glossary](arc42/12-glossary.md) | Project terms |

## Rules

- Keep each fact in one place; link to it from elsewhere.
- Every document starts with a sentence saying what belongs in it and what
  doesn't.
- Anything that isn't architecture stays short (KISS).
