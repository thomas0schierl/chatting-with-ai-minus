# 5. Building block view

> **Belongs here:** the modules under `src/`, what each is responsible for,
> and how they depend on each other. Update it when a file is added,
> removed or changes its job. **Elsewhere:** how they work together over
> time (→ [6](06-runtime-view.md)), rules that apply to all of them
> (→ [8](08-crosscutting-concepts.md)).

## Overview

```
main.ts ──▶ settings.ts ─────────────┐
   │                                 ▼
   ├──▶ ui/chat-view.ts ──▶ ui/ChatContainer.svelte
   │          │
   │          ▼
   └──▶ agent/loop.ts ──▶ api/client.ts ──▶ api/anthropic.ts
          │    │                       ├──▶ api/openai.ts ────────┐
          │    │                       └──▶ api/chatgpt-oauth.ts ─┤──▶ api/responses-format.ts
          │    ▼                                    │              │
          │  tools/registry.ts, tools/executor.ts   ▼              │
          ▼                                auth/chatgptOAuth.ts    │
   agent/context.ts, system-prompt.ts,     auth/chatgptOAuthStore  │
   history.ts                                                      │
                       api/model-catalog.ts ◀── adapters, settings ┘
```

All modules share types from `types.ts`; `plugin-id.ts` holds the plugin ID.

## Modules

| Module | Responsibility |
|---|---|
| `main.ts` | Plugin entry. Loads and saves settings (`data.json`) and API keys (SecretStorage), loads and saves chat history (`chat-state.json`), wires the ChatGPT OAuth service, registers the view, ribbon icon, commands and context menus. |
| `settings.ts` | Settings tab: provider, API key or ChatGPT connect/disconnect, model picker with catalog refresh, thinking level, web search, iteration limit. Also the device-login modal and the chat header label. |
| `ui/chat-view.ts` | Obsidian `ItemView` that mounts the Svelte component and connects its events to the agent loop callbacks. |
| `ui/ChatContainer.svelte` | The whole chat UI: messages (rendered as Obsidian Markdown), tool cards, thinking indicator, selection pill, image tray, input with send and stop. |
| `agent/loop.ts` | The agent loop: owns the message history, calls the provider, runs tools, handles stop and `ask_user`, writes the debug log. |
| `agent/history.ts` | Trims history only at the start of a user turn, so a tool call is never separated from its result. |
| `agent/context.ts` | Collects per-turn context: vault name, note count, active note path, selection. |
| `agent/system-prompt.ts` | The static system prompt and the per-turn context prefix. |
| `api/client.ts` | Picks the adapter for the current provider; one retry on rate limits. |
| `api/anthropic.ts` | Anthropic Messages API adapter (thinking, prompt caching, web search, native replay). |
| `api/openai.ts` | OpenAI Responses API adapter (`previous_response_id` chaining, full replay as fallback). |
| `api/chatgpt-oauth.ts` | ChatGPT/Codex adapter: `store: false`, full replay each turn, buffered SSE parsing. |
| `api/responses-format.ts` | Converts unified messages to and from the Responses API format (shared by OpenAI and Codex). |
| `api/model-catalog.ts` | Loads, caches and normalises model lists per provider and account; Codex client version; thinking and parallel-tool capabilities, and the thinking parameters built from them. |
| `auth/chatgptOAuth.ts` | Device login, token exchange and refresh against `auth.openai.com`. |
| `auth/chatgptOAuthStore.ts` | Reads and writes the OAuth credential in SecretStorage. |
| `tools/registry.ts` | The 14 tool definitions (JSON Schema) offered to the model. |
| `tools/executor.ts` | Runs a tool call against the Obsidian vault and returns a result or an error for the model. |
| `types.ts` | Settings, unified message and response types, defaults. |
| `plugin-id.ts` | The plugin ID, used for keychain keys, paths and User-Agents. |

## Tools

| Tool | Obsidian API | Notes |
|---|---|---|
| `read_document` | `vault.cachedRead()` | Active note if no path given |
| `edit_document` | `vault.process()` / `vault.modify()` | Find/replace, insert, or replace all |
| `search_vault` | `getMarkdownFiles()` + `cachedRead()` | Linear scan, up to 50 results |
| `read_file` | `vault.getFileByPath()` + `cachedRead()` | Any file type |
| `create_file` | `vault.create()` | Creates parent folders |
| `list_files` | `vault.getFiles()` | Up to 100 results |
| `rename_file` | `fileManager.renameFile()` | Updates links |
| `delete_file` | `fileManager.trashFile()` | Respects the user's trash setting |
| `open_document` | `workspace.getLeaf().openFile()` | |
| `get_properties` | `metadataCache.getFileCache()` | Frontmatter |
| `set_properties` | `fileManager.processFrontMatter()` | Merge or remove keys |
| `get_backlinks` | `metadataCache.resolvedLinks` | |
| `get_current_datetime` | `Date` | User's locale and time zone |
| `ask_user` | UI callback | Pauses the loop until the user answers |
