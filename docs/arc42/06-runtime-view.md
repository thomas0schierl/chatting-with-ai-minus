# 6. Runtime view

> **Belongs here:** the important flows, step by step, with the functions
> involved. Add a flow when it's hard to follow from the code alone.
> **Elsewhere:** what each module is for (→ [5](05-building-block-view.md)),
> rules shared by all flows (→ [8](08-crosscutting-concepts.md)).

## Plugin start (`main.ts` `onload`)

1. `loadSettings()`: read `data.json`, check each field, merge over the
   defaults. An empty model becomes the provider's default. The model
   catalog is restored, and the API key is read from SecretStorage.
2. Create the ChatGPT OAuth store and service, and hand the service to the
   ChatGPT adapter. Activate the saved model catalog of the current provider
   and account, so the chat header can show the thinking level.
3. Create the `AgentLoop` with the shared settings object.
4. `loadChatHistory()`: read `chat-state.json` and bring it to the current
   format (`migrateChatState()`; each migration runs once, the next save
   writes the new version). In each conversation, give the visible
   history's images their data from its API messages (same image ID); an
   image no longer there keeps only its name and is shown as a chip. Make
   the saved active conversation active again and import its API messages
   into the agent loop (trimmed to 40). Until this has finished, `saveChatHistory()` does
   nothing, so an early unload can't overwrite the saved chat. No file
   (first run) starts a new chat silently. A file that can't be read or
   isn't a saved chat is renamed to `chat-state.corrupt-<time>.json` and a
   notice says so; if renaming fails too, nothing is saved until the next
   start, so the file is never overwritten.
5. Register the settings tab, view, ribbon icon, commands and menus.

No network requests happen at start.

## Sending a message

1. **Send:** the user presses Enter or Send (or a command such as *Chat
   about this note*). `chat-view.ts` creates a turn ID, shows the message,
   saves it to the UI history (with the ID, images and selection scope) and
   calls `AgentLoop.run(text, callbacks, selection, images, turnId)`.
2. **Turn setup:** `run()` takes a snapshot of the settings, so provider
   and model stay fixed for the turn. It adds the context prefix (and the
   selection-scope instruction), appends the user message with the turn ID,
   and trims the history if it is over 50 messages.
3. **Loop, up to the iteration limit:**
   1. Show the thinking indicator.
   2. Call `client.sendMessage()`, which sends through the provider's
      adapter with `stream: true` (`api/stream.ts`). Each text delta goes
      through `onTextDelta` to the view: the first one replaces the
      thinking indicator with an assistant message, later ones extend it
      (Markdown re-rendered at most every 100 ms). The adapter returns
      only when the stream is complete, with the same response a
      non-streamed request gives.
   3. If the answer was cut off by the token limit, show an error and stop;
      tool calls from a cut-off answer never run.
   4. Store the assistant message, including the provider's native items
      for replay.
   5. If there are no tool calls: deliver the whole text (`onResponse`),
      which replaces the streamed text in the same message and goes into
      the UI history, and end the turn. Anthropic `pause_turn` continues
      instead. With tool calls, the text before them is delivered the same
      way and stays as its own message above the tool cards; text before
      `ask_user` is removed, since the question is shown instead.
   6. Otherwise, first store placeholder results ("cancelled"), then run
      the tools one by one, replacing each placeholder with the real
      result. This keeps every call paired with a result even if the user
      presses Stop. A result may carry images (`view_image`,
      `view_canvas`): they go into the agent history with the result; the
      view gets only the text and an "image sent to the model" marker, so
      `chat-state.json` doesn't hold them twice.
4. **Finish:** the view re-enables input and saves the chat history after
   every turn.

**Stop:** sets a flag and a new run version and aborts the request: a
streamed `fetch` stops reading at once. A request on the `requestUrl()`
fallback can't be cancelled; its result is ignored. Text already shown
stays and is saved in the UI history (not in the API history), as on an
error. A pending `ask_user` question is dropped. A stopped turn that ends
after a newer one has started leaves the newer one's state alone.

**`ask_user`:** shows the question; the user's next input becomes the tool
result instead of a new message. Question and answer stay in the visible
history (and are saved); the answer has no turn ID, so it is no turn of
its own and can't be edited.

## Editing a message / regenerating

Both histories hold each user turn under one ID: the user entry in
`plugin.chatHistory` and the message that starts the turn in
`AgentLoop.messages` (tool calls and results after it belong to the same
turn). Cutting before that message never separates a tool call from its
result.

1. **Edit:** the pencil under a user message (on hover with a mouse,
   always shown on touch screens) turns it into an edit box with its
   images and selection scope, and the note "Changes the AI already made
   to notes stay." Enter or *Save* saves, Esc or *Cancel* cancels,
   Shift+Enter adds a line.
2. **Regenerate:** the action under the last answer (not while a turn
   runs) takes the last user turn's text unchanged.
3. **Cut** (`ObsidianChatView.editMessage()`):
   1. Stop a running turn (as **Stop** above).
   2. `AgentLoop.cutBeforeTurn(id)` keeps the messages before the turn, as
      a new array. A turn missing from the API history was trimmed away,
      so nothing is kept.
   3. Cut the UI history and the shown messages at the turn's entry.
   4. Save `chat-state.json`.
4. **Run:** the text runs as a new turn (new ID) with the old turn's
   images (those still in the API history) and selection scope, as in *Sending a message*. The context
   prefix (active note) is the current one.

- **Providers:** the request after a cut sends the cut history. OpenAI
  finds no response to chain to for the new array and replays in full,
  without `previous_response_id`; chaining resumes with the next turn.
- **Not undone:** notes the AI created or changed after that point stay as
  they are. The removed continuation is gone; there are no branches.
- **Saved without IDs:** each turn added one user entry and one turn
  start, so the migration to version 2 (`assignLegacyTurnIds()`) pairs
  them from the end. Where one
  history reaches further back, its older turns get IDs of their own.

**Copy:** the action under each finished answer copies its Markdown
source (the text as received, before math conversion) and shows
"Copied". Answers still streaming have no actions.

## Conversations

`plugin.conversations` holds every conversation (`ConversationRecord`:
ID, title, `customTitle`, times, visible and API history).
`plugin.chatHistory` is the active one's visible history. Its API history
lives in the `AgentLoop` and is copied into the record when saving,
switching or listing.

1. **New chat** (header button, history list, command, ribbon menu):
   `ObsidianChatView.newChat()` stops a running turn (as **Stop**: the text
   shown so far stays in that conversation), then
   `startNewConversation()` adds an empty conversation and activates it. If
   the current one is still empty, it stays instead. *Chat about this
   note* and *Send selection to chat* (commands, context menus) start a
   new chat the same way before sending or showing the selection.
2. **Switch** (a row of the history list): the same stop, then
   `openConversation(id)`. **Activating** aborts the loop and imports the
   conversation's API history (`importMessages()`): a different array, and
   the OpenAI chaining state is cleared, so the first request replays that
   conversation in full and never chains to another conversation's
   response. An empty conversation left behind is dropped. The view shows
   the new history and title; then save.
3. **Title:** each turn start (and Clear) sets `updatedAt` and, unless
   renamed, the title from the first user message (one line, at most 40
   characters, or the first image's name). Editing the first message
   changes it.
4. **Rename** (pencil in the list): inline field; Enter or leaving it
   saves, Esc cancels. An empty name returns to the automatic title.
5. **Delete** (bin in the list, then *Delete* to confirm): removes the
   record. For the current conversation, the running turn stops first and
   the most recently used other one opens, or a new empty one if none is
   left.
6. **List:** conversations with content, most recently used first; an
   empty new chat isn't listed. Escape or the history button closes it.

**Clear** (header, command) empties the current conversation's histories;
it stays active and, being empty, leaves the list.

## Voice conversation (`voice/`, ADR-11)

1. **Start:** the voice button (shown when `main.voiceRoute()` finds
   a route: an OpenAI API key, or in private builds the Codex sign-in)
   calls `ChatView.startVoice()`, which creates a `VoiceController`.
2. **Connect** (`VoiceSession.start()`): microphone with echo
   cancellation, noise suppression and gain control; peer connection with
   the track and the `oai-events` data channel; the offer, after ICE
   gathering (at most 3 s). The route sends it with our instructions and
   the last 8 chat messages as text:
   - official: `POST https://api.openai.com/v1/live/sessions` (model
     `gpt-live-1`, voice, `delegation: {type: "client"}`, `input`); the
     JSON answer holds the answer SDP.
   - Codex (private builds): `POST
     https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`;
     the answer SDP is the body, the call ID the end of `Location`.
   The answer SDP is applied. The official route waits for
   `session.started` (15 s at most), the Codex route only for the open
   data channel. Remote audio plays in an `<audio>` element; if autoplay
   is blocked, the bar shows **Tap to play audio**.
3. **Talking:** transcript events fill the caption lines; the first
   dialect-specific event decides which dialect we send. *Hold to talk*
   enables the microphone track only while the button is held; *Mute*
   disables it.
4. **Delegation:** the request text is the delegation's text (Codex) or
   the user's words since the last delegation (GPT-Live sends none; we
   wait until no words arrived for 700 ms, at most 2.5 s). A running turn
   is stopped first. The request runs through `handleUserMessage()` like
   a typed message, with a turn ID, tool cards and history, and with
   `voice: true` (a context line asks for a short, speakable answer).
   Text before a tool call and each tool call go back as progress
   (`session.thinking.append`, or Codex `delegation.context.append` on
   the `commentary` channel); the final answer as text to speak
   (`session.commentary.append`, ≤1500 characters each; Codex `speakable`,
   ≤500 bytes each). Answers over 3000 characters are cut and end with
   "The full answer is in the chat." An `ask_user` question is spoken; the
   user answers by voice (a new delegation) or by typing.
5. **End:** **End**, a conversation switch, a new chat, Clear, closing the
   view or unloading sends `session.close`, waits up to 5 s for
   `session.closed`, then closes the connection and stops the microphone.
   A running turn finishes in the chat but isn't spoken. If the server
   ends the session (e.g. `expired`) or the connection fails, the chat
   shows why.

With `DEBUG` on in `agent/loop.ts`, `debug.log` gets every data-channel
event type and its keys (`VOICE_EVENT`), what was sent (`VOICE_SEND`),
the call ID, channel and connection states, and `VOICE_NO_EVENTS` when
nothing arrived within 10 s of the channel opening.

## Provider requests

| | Anthropic | OpenAI | ChatGPT |
|---|---|---|---|
| History sent | All messages; native blocks (thinking signatures, search results) replayed when provider, model and key are unchanged | Only new items, chained with `previous_response_id`; full replay after model or key changes, restore, trimming, or a cut (edit, regenerate) | Full replay every turn (`store: false`, no `previous_response_id`); function tools inside the `vault` namespace |
| Request headers | `anthropic-dangerous-direct-browser-access: true` (CORS for `fetch`) | | |
| Thinking | From the model catalog: `thinking` adaptive or fixed budget (8192 tokens); `output_config.effort` only when the chosen level is offered. None without catalog data | None; `/v1/models` reports no reasoning data | From the model catalog: `reasoning.effort` = chosen level if offered, else the model's default; `summary` unless the model rejects it. None without catalog data |
| Response | SSE (`stream: true`); content blocks rebuilt from `content_block_*` events (text, thinking and signature deltas, tool input JSON, citations); done only at `message_stop`. Web search blocks (`server_tool_use`, `web_search_tool_result` with encrypted results) stay in the replay only; the pages cited in the text are listed under the answer as *Sources* | SSE (`stream: true`); `response.output_text.delta` for text, items from `response.output_item.done`; done only at `response.completed` | same as OpenAI (the route requires `stream: true`) |
| Images in tool results | `image` blocks inside the `tool_result` content | `function_call_output.output` as an array of `input_text` and `input_image` (data URL) | same as OpenAI |
| Older tool images | Sent only for tool results of the last 2 user turns; older results become text with a note such as "[image from view_canvas omitted to save context]" (`withoutOldToolImages()`, at encoding; the stored history and images the user attached are unchanged) | same | same |
| Caching | `cache_control` on the system prompt and last tool | provider-side | provider-side |

## ChatGPT sign-in (`auth/chatgptOAuth.ts`)

OpenAI's "Sign in with ChatGPT" for open-source apps (ADR-13).

1. **Start:** *Continue with ChatGPT* opens a modal, and `beginSignIn()`
   builds the authorize URL:
   - fresh `state`, `nonce` and PKCE verifier (S256 challenge);
   - `redirect_uri` `http://127.0.0.1:<random port 49152–65535>/auth/callback`;
   - `resource` `https://api.openai.com/v1` and the plan scopes;
   - `ext_agent_host_id`, created once per device;
   - first sign-in: `client_id=dynamic_agent_client` and
     `agent_name_hint`; later: the issued client ID and the saved email as
     `login_hint`.

   The attempt is saved in SecretStorage and reused, also after a restart,
   until its code is exchanged or it is 10 minutes old. A phone that kills
   Obsidian while the user is in the browser can still finish the paste.
2. **Browser:** *Open sign-in page* opens it in the system browser. The
   user signs in and allows plan use; the browser then lands on the
   `127.0.0.1` address, which doesn't load.
3. **Paste:** the user copies that address into the modal.
   `parseCallback()` requires the full address with the same redirect URI
   and `state`, handles `error=access_denied`, and takes `code` and the
   issued `client_id` (`oaiapp_…`), which is saved at once.
4. **Exchange:** `completeSignIn()` loads OpenAI's signing keys (discovery
   document → `jwks_uri`, cached in memory) before it spends the code, then
   posts the code, verifier, redirect URI and resource to `/oauth/token`.
   It verifies the ID token's RS256 signature (`auth/rs256.ts`, BigInt
   and `@noble/hashes`, so it runs without SubtleCrypto; an unknown `kid`
   refetches the keys once), then issuer, audience, expiry and nonce, and
   that `chatgpt.tokens.use.direct` was granted, and stores the
   credential. Without the keys sign-in fails closed and the attempt stays
   open for another paste.
5. **Refresh:** `getUsableCredential()` refreshes within a minute of
   expiry, with the issued client ID and resource; one refresh at a time,
   since refresh tokens rotate. An unusable refresh token clears the
   sign-in; network and server errors keep it. A chat request answered
   with 401 refreshes once (`renewRejected()`: a token another request
   already refreshed is used as is) and is sent again once; a second 401
   shows the "sign in again" error.
6. **Disconnect:** `signOut()` revokes the refresh token (one retry after
   a network error or 5xx), then clears the tokens. The host and client ID
   stay for the next sign-in.
7. **Use another account** (account row, or the link in the sign-in
   modal): `beginSignIn({ newAccount: true })` registers anew with
   `dynamic_agent_client` and `agent_name_hint`, under the same host ID
   (it names the device, not the account; OpenAI keeps it when switching).
   - A connected account stays until the new one is validated; then its
     refresh token is revoked and registration and credential are
     replaced.
   - Without a connected account, the issued client ID is saved at once.
   - A returning sign-in (issued client) with another `sub` is still
     refused: an issued client is bound to its account.
   - Only one registration is kept; switching back registers that account
     anew.
8. **Plan use declined:** `error=access_denied`, or a token response
   without `chatgpt.tokens.use.direct`, offers *Try again and allow
   ChatGPT plan use*: a new attempt with the full scope set and
   `prompt=consent` (OpenAI's `force_reconsent=true` replaces it once
   rolled out). Ordinary sign-ins never force consent.

## Model list refresh (`api/model-catalog.ts`)

1. **Trigger:** opening settings shows the cached list. If it is older than
   24 hours it refreshes in the background; the refresh button forces it.
2. **Cache key:** the hash of provider plus API key or ChatGPT account, so
   switching accounts never shows another account's list.
3. **Fetch:**
   - **ChatGPT:** fetch `/v1/models` with the ChatGPT-plan token; the
     answer is `{models: [...]}`. Keep the models whose `visibility` is
     `list`, labelled with `display_name`; reasoning levels are read when
     the entry has them.
   - **Anthropic, OpenAI:** fetch `/v1/models`. For Anthropic, read each
     model's thinking type (`capabilities.thinking.types`) and effort
     levels (`capabilities.effort`).
4. **Result:** the new list is saved to `data.json`. On failure the last
   list is kept, and there are no retries for 5 minutes.

## Thinking level (`settings.ts`, adapters)

1. **Options:** the settings row below Model lists "Default" plus the
   levels the catalog reports for the selected model, in the provider's
   order. It is hidden for models without levels (all OpenAI API models,
   custom IDs).
2. **Saved choice:** `thinkingLevel` stays saved when the model changes. A
   level the new model doesn't offer is shown as "(not available)" and
   requests use the model's default. Changing the provider resets it.
3. **Header:** the chat header shows the model name and the effective
   level (`GPT-5.5 · high`, `GPT-5.5 · medium (default)`).
