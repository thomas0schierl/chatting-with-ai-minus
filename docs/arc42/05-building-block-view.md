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
          │    │                 (all three adapters ──▶ api/stream.ts)
          │    ▼                                    │              │
          │  tools/registry.ts, tools/executor.ts   ▼              │
          ▼                                auth/chatgptOAuth.ts    │
   agent/context.ts, system-prompt.ts,     auth/chatgptOAuthStore  │
   history.ts                                                      │
                       api/model-catalog.ts ◀── adapters, settings ┘
```

All modules share types from `types.ts`; `plugin-id.ts` holds the plugin ID;
`images.ts` (image limits and re-encoding) serves the image tools.

## Modules

| Module | Responsibility |
|---|---|
| `main.ts` | Plugin entry. Loads and saves settings (`data.json`) and API keys (SecretStorage), loads and saves chat history (`chat-state.json`; gives turns saved without turn IDs matching ones), wires the ChatGPT OAuth service, registers the view, ribbon icon, commands and context menus. |
| `settings.ts` | Settings tab: provider, API key or ChatGPT connect/disconnect, model picker with catalog refresh, thinking level, web search, iteration limit. Also the device-login modal and the chat header label. |
| `ui/chat-view.ts` | Obsidian `ItemView` that mounts the Svelte component and connects its events to the agent loop callbacks; turns text deltas into a growing assistant message. Gives each user turn its ID; edit and regenerate cut both histories before a turn and run it again; copies an answer's Markdown. |
| `ui/ChatContainer.svelte` | The whole chat UI: messages (rendered as Obsidian Markdown, a streamed answer at most every 100 ms), tool cards, thinking indicator, selection pill, image tray, input with send and stop. An edit action and inline edit box on user messages; Copy under finished answers, Regenerate under the last. Keeps the latest question at the top while its answer arrives. |
| `ui/math-markdown.ts` | Converts `\(…\)`, `\[…\]` and math code fences to Obsidian's `$`/`$$` at render time, leaving code untouched. |
| `agent/loop.ts` | The agent loop: owns the message history (each user turn starts with a message carrying its turn ID) and cuts it before a turn, calls the provider, passes text deltas to the view, runs tools, handles stop (aborts the request) and `ask_user`, writes the debug log. |
| `agent/history.ts` | Trims and cuts history only at the start of a user turn, so a tool call is never separated from its result. Creates turn IDs and adds them to chats saved without them. |
| `agent/context.ts` | Collects per-turn context: vault name, note count, active note path, selection. |
| `agent/system-prompt.ts` | The static system prompt and the per-turn context prefix. |
| `api/client.ts` | Picks the adapter for the current provider; one retry on rate limits while no text has been shown. |
| `api/stream.ts` | The transport for chat: POST with `fetch`, an incremental SSE parser, abort; falls back to `requestUrl()` (and stays there for the session) when `fetch` fails before a response. The only module using `fetch` besides the device check. |
| `api/anthropic.ts` | Anthropic Messages API adapter (streamed; thinking, prompt caching, web search, native replay). Rebuilds the message from stream events. |
| `api/openai.ts` | OpenAI Responses API adapter (`previous_response_id` chaining, full replay as fallback). |
| `api/chatgpt-oauth.ts` | ChatGPT adapter (`api.openai.com/v1/responses` with the ChatGPT-plan token): `store: false`, full replay each turn, tools in a namespace. |
| `api/responses-format.ts` | Converts unified messages to and from the Responses API format, and rebuilds a response from its stream events (shared by the OpenAI and ChatGPT adapters). |
| `api/model-catalog.ts` | Loads, caches and normalises model lists per provider and account; thinking and parallel-tool capabilities, and the thinking parameters built from them. |
| `auth/chatgptOAuth.ts` | ChatGPT sign-in (authorize URL, pasted callback, token exchange, ID token check), refresh and revocation against `auth.openai.com`. |
| `auth/chatgptOAuthStore.ts` | Reads and writes the ChatGPT credential, registration and pending sign-in in SecretStorage. |
| `auth/rs256.ts` | RS256 signature check for ID tokens in plain JS (BigInt, `@noble/hashes`), since SubtleCrypto may be missing on mobile. |
| `tools/registry.ts` | The 18 tool definitions (JSON Schema) offered to the model. |
| `tools/executor.ts` | Runs a tool call against the Obsidian vault and returns a result (text, and images for `view_image` and `view_canvas`) or an error for the model. |
| `tools/canvas.ts` | JSON Canvas 1.0 without vault access: parse, write in Obsidian's format, the outline for `read_canvas`, the `edit_canvas` operations (IDs, placement without overlap, validation) and the searchable canvas text. |
| `tools/canvas-render.ts` | Draws a canvas for `view_canvas` with Canvas 2D: layout and scaling (whole canvas or one group or node), groups, cards with plain text, image files, links, edges with arrows and labels, colour presets, an ID tag per node, and the text legend. The drawing surface and image loading are passed in, so tests use fakes. |
| `images.ts` | Image limits (5 MB, 2048 px long side) and re-encoding via `createImageBitmap` and `<canvas>`, shared by the image tools. Attachments in `ChatContainer.svelte` still have their own copy. |
| `types.ts` | Settings, unified message and response types, defaults. |
| `plugin-id.ts` | The plugin ID, used for keychain keys, paths and User-Agents. |

## Tools

| Tool | Obsidian API | Notes |
|---|---|---|
| `read_document` | `vault.cachedRead()` | Active note if no path given |
| `edit_document` | `vault.process()` / `vault.modify()` | Find/replace, insert, or replace all |
| `search_vault` | `getMarkdownFiles()`, `getFiles()` + `cachedRead()` | Linear scan of notes and canvases (card text, group and edge labels, with the node or edge ID), up to 50 results |
| `read_file` | `vault.getFileByPath()` + `cachedRead()` | Any text file, raw; refuses images (hint: `view_image`) and other binary files by extension |
| `view_image` | `vault.readBinary()` | PNG, JPEG, GIF or WebP, returned as an image; scaled down past 2048 px or 5 MB (GIFs are never re-encoded) |
| `read_canvas` | `vault.getFileByPath()` + `cachedRead()` | `.canvas` only: groups with their nodes, other nodes, edges, with IDs, positions and sizes |
| `view_canvas` | `cachedRead()`, `readBinary()` for image nodes | `.canvas` only: a PNG of the layout (at most 1600 px, optional `focus` on a group or node) and a legend of the node tags; Markdown in cards is drawn as plain text |
| `edit_canvas` | `vault.process()` | `.canvas` only: add, update, move or remove nodes and edges; all operations or none; keeps unknown fields |
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
