# Chatting with AI Minus

> **Belongs here:** what the plugin does, how to install and set it up,
> and what users need to know about privacy. **Elsewhere:** how it works
> inside (→ [docs/arc42](docs/arc42/)), how to develop it
> (→ [AGENTS.md](AGENTS.md)).

An AI chat for Obsidian that can read, search, create and edit your notes.
It works the same on desktop, iPhone, iPad and Android.

## Features

- **Three providers:** Anthropic (API key), OpenAI (API key), or sign in
  with your ChatGPT account.
- **Works with your vault:** the AI can read, search, list, create, edit,
  rename and trash notes, change frontmatter, find backlinks, and ask you
  when something is unclear.
- **Selection scope:** select text in a note, choose *Send selection to
  Chat*, and the AI changes only that text.
- **Images:** attach or paste up to four images per message, for models
  that accept them.
- **Current models:** model lists are loaded from each provider when you
  open the settings, and kept for a day.

## Install

Until the plugin is listed in Obsidian's community plugins:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest
   GitHub release of this repository.
2. Put them in `<vault>/.obsidian/plugins/chatting-with-ai-minus/`.
3. In Obsidian, enable **Chatting with AI Minus** under **Settings →
   Community plugins**.

## Set up

1. Open **Settings → Chatting with AI Minus** and pick a provider.
2. Paste an API key, or for ChatGPT click **Connect ChatGPT** and enter the
   shown code on the login page.
3. Open the chat from the ribbon icon or the command palette.

ChatGPT sign-in needs a ChatGPT plan with Codex access. It uses the same
backend as OpenAI's Codex CLI, not the public OpenAI API, so it can break
when OpenAI changes that backend. The API-key providers are the stable
option.

## Privacy

- **Sent to the provider:** your messages and attached images, the vault
  name, the number of notes, the active note's path, selected text, and
  whatever note content the AI reads with its tools during that turn.
  Nothing is sent in the background, and there is no vault index.
- **API keys and ChatGPT tokens:** stored in your OS keychain, never in
  plugin files.
- **Chat history:** stored locally in `chat-state.json` in the plugin
  folder.

## Credits and licence

MIT licence. Forked from [Chatting with AI](https://github.com/o1xhack/obsidian-chatting)
by Yuxiao (o1xhack), which derives from [Obsidian Chat](https://github.com/omarshahine/obsidian-chat)
by Omar Shahine. Their copyright notices are kept in [LICENSE](LICENSE).
