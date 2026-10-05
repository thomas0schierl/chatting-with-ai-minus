# TD-003: "Custom..." saves an empty model

Choosing "Custom..." in the model dropdown clears the saved model before
the user types one.

- **Where:** model dropdown in `src/settings.ts`
- **Impact:** low; confusing settings, and the model falls back to a default
  if Obsidian restarts before an ID is typed

## Problem

- Selecting "Custom..." saves `model: ""`.
- The dropdown then shows the first list entry as selected although no
  model is set.
- The custom ID placeholder for Anthropic is the outdated
  `claude-sonnet-4-20250514`.

## Fix

- Treat "Custom..." as UI state only: show the ID field pre-filled with the
  current model, and save only a non-empty typed ID.
- Use the provider's default model as the placeholder.
- Reference implementation: branch `schierl/chatgpt-dropdown-custom-reset-94798c`,
  `editingCustomModel` in `src/settings.ts`.
