# GAP-021: The chat doesn't show it runs on the user's ChatGPT plan

OpenAI's UI guidelines for "Sign in with ChatGPT" ask apps to make plan use
visible in the chat; today only settings shows it ("Manage usage").

- **Where:** `ui/ChatContainer.svelte`, `ui/chat-view.ts`, `settings.ts`
- **Impact:** low–medium (guideline compliance before publishing)

## Problem

- **No indicator:** nothing in the chat says answers count against the
  ChatGPT plan.
- **No welcome:** there's no short welcome after the first sign-in.
- **Usage limit:** reaching it shows only an error bubble, with no dialog
  linking to the usage settings.

## Fix

- **Indicator:** a small "Using your ChatGPT plan" label next to the model
  name in the chat header, only for the ChatGPT provider.
- **Welcome:** a one-time welcome line after the first sign-in.
- **Usage-limit dialog:** on a usage-limit error, a dialog with the
  message and a "Manage usage" button
  (`https://chatgpt.com/settings/usage`).
- Check the wording against OpenAI's UI/UX guidelines page for "Sign in
  with ChatGPT" before building.
