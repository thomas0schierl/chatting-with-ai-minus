# 1. Introduction and goals

> **Belongs here:** what the plugin is for, its main features, its top
> quality goals and who cares about it. **Elsewhere:** how features are
> built (→ [5](05-building-block-view.md)), how to install and use it
> (→ [README](../../README.md)).

## Purpose

Chatting with AI Minus is an Obsidian plugin for chatting with an AI that
can read, search, create and edit notes in the vault through tools. It runs
the same on desktop, iOS and Android.

The aim is the feel of the ChatGPT, Claude and Codex apps (editing and
regenerating messages, voice, many conversations), but inside Obsidian and
working on the user's notes. What those apps do that we don't yet is
tracked as gaps in [11](11-risks-and-technical-debt.md).

It is a fork of [Chatting with AI](https://github.com/o1xhack/obsidian-chatting)
(o1xhack), which derives from [Obsidian Chat](https://github.com/omarshahine/obsidian-chat)
(Omar Shahine). The fork keeps the code simple.

## Main features

- Chat in a side panel, with three providers: Anthropic (API key), OpenAI
  (API key) and ChatGPT account sign-in (uses the ChatGPT plan).
- 18 vault tools: read, search, list, create, edit, rename, trash, open,
  frontmatter, backlinks, canvas reading and editing, looking at images and
  canvases, date and time, and asking the user a question.
- Selection scope: send selected text to the chat, and edits stay inside it.
- Image attachments for models that accept images.
- Model lists loaded from each provider's API.
- Named conversations: start a new chat, switch, rename and delete them
  from a history list; they survive restarts.

## Quality goals

| Priority | Goal | Meaning |
|---|---|---|
| 1 | Mobile parity | Every feature works on iOS and Android exactly as on desktop. |
| 2 | Familiar app feel | Someone used to the ChatGPT or Claude app finds the same interactions and responsiveness. |
| 3 | Simplicity | Little code, no clever abstractions (KISS); a feature earns its place by serving goal 2 or the vault work. |
| 4 | Safe user data | Credentials never leave the OS keychain; notes and chat history are never lost or sent anywhere unasked. |
| 5 | Provider resilience | New models work without a plugin update; provider changes fail with a clear message. |

Details and test scenarios: [10](10-quality-requirements.md).

## Stakeholders

| Who | Expects |
|---|---|
| Users (desktop and mobile) | A dependable chat that edits their notes as asked and nothing else. |
| Maintainers | Code and docs that are easy to change. |
| Obsidian plugin review | Compliance with the plugin guidelines. |
| Upstream projects | Credit under the MIT licence. |
