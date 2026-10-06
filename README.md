# Chatting with AI Minus

> **Belongs here:** what the plugin does, how to install, set up and
> troubleshoot it (also on a phone), and what users need to know about
> privacy. **Elsewhere:** how it works
> inside (→ [docs/arc42](docs/arc42/)), how to develop it
> (→ [AGENTS.md](AGENTS.md)).

An AI chat for Obsidian that can read, search, create and edit your notes.
It works the same on desktop, iPhone, iPad and Android, with one
difference: on phones, answers on the ChatGPT plan appear when complete
instead of as they're written.

## Features

- **Three providers:** Anthropic (API key), OpenAI (API key), or sign in
  with your ChatGPT account.
- **Works with your vault:** the AI can read, search, list, create, edit,
  rename and trash notes, change frontmatter, find backlinks, read and edit
  canvases, look at images and canvases, and ask you when something is
  unclear.
- **Streaming:** answers appear as they're written; **Stop** ends one
  early.
- **Edit, regenerate, copy:** edit an earlier message and run it again,
  regenerate the last answer, copy an answer as Markdown.
- **Web search and thinking level:** turn web search on in the settings,
  and pick how much the model thinks, where the model offers levels.
- **Enter sends message:** on by default (Shift+Enter starts a new line).
  Turn it off in the settings to make Enter start a new line; then send
  with the send button or Ctrl+Enter (Cmd+Enter on a Mac).
- **Conversations:** start a new chat at any time; switch, rename and
  delete earlier chats from the history list. The chat that was open comes
  back after a restart.
- **Selection scope:** select text in a note, choose *Send selection to
  chat*, and the AI changes only that text.
- **Images:** attach or paste up to four images per message, for models
  that accept them.
- **Current models:** model lists are loaded from each provider when you
  open the settings, and kept for a day.
- **Voice:** talk with the assistant in the current chat and hear the
  answer (see [Voice](#voice)).
- **Leaving the app on a phone:** an interrupted answer continues when
  you come back (see [On a phone](#on-a-phone)).

## Commands

From the command palette:

- **Open chat**, **New chat**
- **Copy conversation transcript to clipboard**, **Clear conversation**
- **Chat about this note** (also in the file menu) and **Send selection
  to chat** (also in the editor's right-click menu): both start a new chat.
- **Check device capabilities (voice, streaming)** and **Copy debug log**:
  see [Troubleshooting](#troubleshooting).

The ribbon icon opens the chat; right-click it for Open chat, New chat,
Chat about active note and Copy transcript.

## Install

The plugin isn't in Obsidian's community plugins yet, and there is no
GitHub release yet. Build it from source (Obsidian 1.13.0 or later):

1. `npm install`, then `npm run build`.
2. Copy `main.js`, `manifest.json` and `styles.css` (the build creates
   it) into `<vault>/.obsidian/plugins/chatting-with-ai-minus/`.
3. In Obsidian, enable **Chatting with AI Minus** under **Settings →
   Community plugins**.

Once there are releases, download the same three files from the latest
GitHub release instead of building them.

## Set up

1. Open **Settings → Chatting with AI Minus** and pick a provider.
2. Paste an API key, or for ChatGPT click **Continue with ChatGPT**:
   1. Click **Open sign-in page** and sign in to ChatGPT in your browser.
   2. The browser then lands on a `http://127.0.0.1:…` page that won't
      load. Copy that page's full address, paste it into the plugin and
      click **Connect**.
3. Open the chat from the ribbon icon or the command palette.

ChatGPT sign-in uses OpenAI's "Sign in with ChatGPT" for open-source apps,
which is still a preview. Chats then count against your ChatGPT plan,
shown as **Using ChatGPT plan** above the chat input; **Manage usage**
there or in the settings opens your usage limits.

## Voice

Voice uses OpenAI GPT-Live and needs an **OpenAI API key**, whichever
provider you chat with (the ChatGPT sign-in doesn't include audio). Enter
it under **Settings → Chatting with AI Minus → Voice** (it is the same key
as for the OpenAI provider) and use **Check access** to see whether your
account can use `gpt-live-1`. OpenAI bills voice at **$0.05 per minute**
of conversation, silence included, until you end it; the chat model's
answers are billed as usual.

- **Start:** the voice button (a circle with sound-wave bars) sits where
  Send is. It shows while the input is empty, nothing is attached, no
  answer is running and the AI isn't waiting for your answer to a
  question.
- **During a call** the voice bar replaces the input row: the microphone
  button (tap to mute) or, with *Hold to talk*, the button you hold while
  speaking; a line showing your current words, or else whether the
  assistant is listening, working or speaking; and a red **✕** to end.
- **Hands-free or hold to talk:** choose under **Voice → Microphone**.
- **In the chat:** your requests and the answers appear as chat
  messages, tool steps included. Small talk the voice handles itself is
  only heard.
- **Say more while it works:** what you add is passed to the running task
  instead of starting over. If the AI asks you a question, answer it by
  voice (or end the call and type).
- **Ending:** the **✕**, switching or starting a chat, Clear, or closing
  the chat panel.

On Android the microphone and the voice connection work; a full voice
conversation on a phone and iOS are not verified yet.

## On a phone

- **Getting the plugin there:** build on a computer (see
  [Install](#install)) and let a sync copy the plugin folder, e.g.
  Obsidian Sync with **Installed community plugins** on, or another sync
  of the `.obsidian` folder. Then enable the plugin on the phone.
- **Per device:** API keys and sign-ins are kept in the device's
  keychain, so enter them on each device. Chats (`chat-state.json`) stay
  on the device; the plugin doesn't sync them.
- **Voice:** the phone asks for microphone access the first time. If you
  denied it, allow Obsidian's microphone in the system settings. Keep the
  chat panel open during a call. Billing runs until you end the call, or
  until it ends after 60 s in the background.
- **Screen stays on:** while an answer is generated and during a voice
  call, the screen doesn't go to sleep (where the phone allows it).
- **No word-by-word answers with the ChatGPT plan:** they appear when
  complete; Stop before that leaves a "Stopped." note.
- **Leaving the app:** nothing progresses while Obsidian is in the
  background. When you come back, an interrupted answer is requested
  again ("Resuming…"), which costs its tokens again. If the phone closed
  Obsidian meanwhile, the chat offers **Continue**; it never continues by
  itself. Voice mutes the microphone while you're away and reconnects
  when you return.

## Troubleshooting

- **Check device capabilities** shows what this device supports
  (microphone, live audio, streaming) in a window you can copy.
- To send a log: turn on **Debug log** in the settings, repeat the
  problem, then **Copy debug log** (command, or **Copy** in the settings)
  and paste it into a message. **Clear** deletes it.

## Privacy

- **Sent to the provider:** your messages and attached images, the vault
  name, the number of notes, the active note's path, selected text, and
  whatever note content and images the AI reads with its tools during that
  turn. Nothing is sent in the background, and there is no vault index.
- **Voice:** while a voice conversation runs, your microphone audio and
  the last few chat messages (as text) go to OpenAI.
- **API keys and ChatGPT tokens:** stored in your OS keychain, never in
  plugin files.
- **Chat history:** all conversations are stored locally in
  `chat-state.json` in the plugin folder; deleting a conversation removes
  it from there.
- **Debug log:** off by default. While on, `debug.log` in the plugin
  folder records requests, errors and events, including your messages
  (never keys).
- **Check device capabilities:** with your keys, it sends short test
  requests to Anthropic and OpenAI and opens a GPT-Live session for a
  moment, which costs a little.

## Credits and licence

MIT licence. Forked from [Chatting with AI](https://github.com/o1xhack/obsidian-chatting)
by Yuxiao (o1xhack), which derives from [Obsidian Chat](https://github.com/omarshahine/obsidian-chat)
by Omar Shahine. Their copyright notices are kept in [LICENSE](LICENSE).
