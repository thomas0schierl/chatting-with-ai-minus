# TD-006: Thinking level can't be set and is partly guessed from model names

Users can't choose how much the model thinks, and some providers decide
thinking support from the model name instead of the provider's data.

- **Where:** `src/api/anthropic.ts`, `src/api/openai.ts`,
  `oauthReasoning()` / `supportsReasoning()` in `src/api/model-catalog.ts`,
  `src/settings.ts`, chat header in `src/ui/ChatContainer.svelte`
- **Impact:** medium; no way to trade speed for depth, and new models can
  get wrong or missing thinking parameters

## Problem

- **No setting and no display:** there is no thinking-level setting, and the
  chat header doesn't show one.
- **ChatGPT:** effort comes from the model list (`reasoningEfforts`,
  `defaultReasoningEffort`). Models not in the list fall back to a name
  check (`gpt-N` with N >= 5, `o<digit>`, `codex`) and `medium`.
- **Anthropic:** thinking mode comes from name patterns. Opus/Sonnet 4.6+
  get adaptive thinking and older Opus/Sonnet get a fixed budget. Other
  models, such as Haiku 4.5, get none, and no effort is ever sent.
- **OpenAI:** a name check plus a fixed `medium`.

## Fix

- Add a "Thinking level" setting below Model. Its options are "Default"
  plus the levels the provider reports for the selected model, with no
  hardcoded list. Hide it for models without levels.
- Show the effective level in the chat header (`GPT-6-Astra · high`).
- **ChatGPT:** chosen level, else the model's default. No reasoning
  parameters for models without list data.
- **Anthropic:** read `capabilities.thinking.types` and
  `capabilities.effort` from `/v1/models`, and send adaptive or budget
  thinking plus `output_config.effort` from that data.
- **OpenAI:** `/v1/models` reports no reasoning data, so send none and use
  the model's default.
- Reference implementation: branch `schierl/chatgpt-dropdown-custom-reset-94798c`
  (tested live with a ChatGPT account on 2026-09-29).
