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
   into the agent loop (as saved: at most 80). Until this has finished, `saveChatHistory()` does
   nothing, so an early unload can't overwrite the saved chat. Both
   `chat-state.json` and its copy `chat-state.next.json` are read; the
   newer whole one is used (see §8), so a save cut off while writing
   either file loses nothing. No file
   (first run) starts a new chat silently. A file that can't be read or
   isn't a saved chat is renamed to `chat-state.corrupt-<time>.json` and a
   notice says so; if renaming fails too, nothing is saved until the next
   start, so the file is never overwritten.
5. Start the lifecycle hints (`platform/lifecycle.ts`, ADR-15); leaving
   the app saves the chats from then on.
6. Register the settings tab, view, ribbon icon, commands and menus.

No network requests happen at start.

## Sending a message

1. **Send:** the user presses Enter or Send (or a command such as *Chat
   about this note*). `chat-view.ts` creates a turn ID, shows the message,
   saves it to the UI history (with the ID, images and selection scope) and
   calls `AgentLoop.run(text, callbacks, selection, images, turnId)`.
2. **Turn setup:** `run()` takes a snapshot of the settings, so provider
   and model stay fixed for the turn. It adds the context prefix (and the
   selection-scope instruction), appends the user message with the turn ID,
   and trims the history to the last 80 messages (whole turns), the cap
   that saving uses too. With a selection, the tools also enforce it for
   the turn (the instruction alone isn't always followed): on that note
   only `edit_document` `find_replace` with text from the selection runs,
   applied to the selected occurrence (found at its saved offset, so a
   repeated text elsewhere isn't mistaken for it; its first copy only if
   the note changed there), and the scope then holds the
   changed text for later edits in the turn; a whole-note replace, an
   insert, properties, rename and delete of that note (or of a folder it is
   in) are refused with a
   message the model can act on. Other notes stay editable. A turn
   continued after a restart has no scope (it isn't saved).
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

**Stop:** sets a flag and a new run version and aborts the request (each
request has its own abort controller): a streamed `fetch` stops reading
at once. A request on the `requestUrl()` fallback can't be cancelled; the
abort settles it at once and its result is ignored. Text already shown
stays and is saved in the UI history (not in the API history), as on an
error. When none of the answer was on screen yet (no streaming, e.g. the
ChatGPT plan on phones), a quiet "Stopped." note is added instead (an
error entry with `errorKind: "stopped"`). A pending `ask_user` question
is dropped. A stopped turn that ends
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
   Shift+Enter adds a line (with *Enter sends message* off: Enter adds a
   line, Ctrl/Cmd+Enter saves, as in the input).
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
  they are (Undo on an answer's changes row takes them back, see below).
  The removed continuation is gone; there are no branches.
- **Saved without IDs:** each turn added one user entry and one turn
  start, so the migration to version 2 (`assignLegacyTurnIds()`) pairs
  them from the end. Where one
  history reaches further back, its older turns get IDs of their own.

**Copy:** the action under each finished answer copies its Markdown
source (the text as received, before math conversion) and shows
"Copied". Answers still streaming have no actions.

## Undoing an answer's changes (`tools/undo.ts`)

1. **Record:** each turn gets a `ChangeLog` (in the agent callbacks). The
   tools add each successful change: `edit_document`, `set_properties`
   and `edit_canvas` the text before and after; `create_file` the new
   file; `rename_file` both paths; `delete_file` first reads the file's
   bytes (a folder's files and subfolders too).
2. **Show:** a turn with changes (also a stopped one) ends in a changes
   entry, `{ type: "changes", turnId, files }`, saved with the chat:
   "Changed Plan, Ideas" with **Undo**. It goes before a later turn that
   started meanwhile. The log itself is kept in `plugin.changeLogs` (in
   memory): after Obsidian restarts the row shows without Undo.
3. **Undo** (not while a turn runs): files whose state differs from what
   the answer left (the user or a later answer changed them) are named in
   a dialog first; *Cancel* changes nothing. Then the steps are taken back,
   last first: text written back, created files to the trash, renames
   renamed back (links in other notes follow), deleted files created again
   with their folders. What fails is named in a notice.
4. **Tell the model:** the row shows "Undid the changes to …"; the
   conversation keeps a note (`notes`, saved) that goes into the context
   prefix of the next turn only.

Undo applies to the vault only; the answer stays in the chat.

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

**Clear** (the header's red trash icon, command) empties the current conversation's histories;
it stays active and, being empty, leaves the list.

## Typing while an answer runs

The input stays usable during a turn. With text in it the action slot is
Send, without it Stop. `ChatView.handleUserMessage()` sees the running turn
and calls `AgentLoop.steer()` (as voice steering does): the message shows
as *Queued* above the input until the loop adds it to its next step
(after the current tool results); then it moves into the chat as a user
message without a turn ID. Messages the turn had no step left for run as
the next turn once the answer is in. Without streaming (the ChatGPT plan
on phones) this works the same: steps are separate requests. Images and
the selection wait for the next turn; Stop, Clear and switching drop the
queue.

## Following the AI's edits (`ui/show-in-view.ts`)

1. **What changed:** `edit_document`, `set_properties` and `create_file`
   compare the note before and after (`changedRange()`: the text between
   the unchanged start and end) and add it to their result as `focus`;
   `edit_canvas` adds the cards it added or changed. `focus` goes to the
   chat view only, not to the model, and isn't saved.
2. **Show:** with *Follow the AI's edits* on (the default; also the eye
   button in the chat header), `ChatView` shows each `focus` in turn
   (`showInView()`), without taking the focus from the chat input:
   - the tab that already shows the file, else the follow tab, else a new
     tab that becomes the follow tab (a tab the user opened is never
     taken over for another note);
   - Obsidian's search-match ephemeral state: in edit view the range is
     highlighted until the user clicks into the note, in reading view the
     line is scrolled to and flashes; a deletion shows its line;
   - on a canvas the match state selects the first card and pans it into
     view; then all changed cards are selected and centered, zooming out
     (never in) only when they don't fit with a 10 % margin
     (`viewportFor()`). That uses the canvas view's internal API
     (`nodes`, `selection`, `updateSelection`, `tx`/`ty`/`tZoom`), checked
     first, so without it the match state's select-and-pan stays;
   - an open note takes in the change a moment after the file is written,
     so the highlight waits until the view shows the new text (at most
     about 1 s);
   - on a phone the chat covers the note, so the tab isn't brought
     forward (that would close the chat);
   - the follow tab closes when the plugin unloads (also when Obsidian
     closes). Its ID is kept per vault (`saveLocalStorage`): if Obsidian
     saved the layout with the tab, it is closed at the next start
     (`closeLeftoverFollowTab`, on layout ready).
3. **On request:** `open_document` shows a `text` or canvas `node_id` the
   same way and brings it forward (also on a phone). Its description
   limits it to when the user asks to open, show or go to something.

## Voice conversation (`voice/`, ADR-11)

1. **Start:** the voice button sits in the input's one action slot. It
   shows when `main.voiceRoute()` finds a route (an OpenAI API key, or the
   Codex sign-in if the user chose that route) and the input is empty, nothing is
   attached, no turn runs and no `ask_user` question is open. It calls
   `ChatView.startVoice()`, which creates a `VoiceController`; the voice
   bar replaces the input row.
2. **Connect** (`VoiceSession.start()`): microphone with echo
   cancellation, noise suppression and gain control; peer connection with
   the track and the `oai-events` data channel; the offer, once ICE
   gathering is complete or 0.5 s after the first candidate (at most 2 s;
   without STUN servers the usable host candidates come at once, phones
   report "complete" late). The route's `prepare()` runs from the start
   (Codex: the sign-in check and the version lookup), so it overlaps with
   the microphone and the offer. The debug log gets each step's duration
   (`VOICE_TIMING`). The route sends the offer with our instructions and
   the last 8 chat messages as text:
   - official: `POST https://api.openai.com/v1/live/sessions` (model
     `gpt-live-1`, voice, `delegation: {type: "client"}`, `input`); the
     JSON answer holds the answer SDP.
   - Codex (unofficial, ADR-14): `POST
     https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`;
     the answer SDP is the body, the call ID the end of `Location`.
   The answer SDP is applied. The official route waits for
   `session.started` (15 s at most), the Codex route only for the open
   data channel. Remote audio plays in an `<audio>` element; if autoplay
   is blocked, the bar shows **Tap to play audio**.
3. **Talking:** the user's transcript events fill the one live caption
   (the user's current words, cleared once the voice answers; otherwise
   the bar shows the state); the voice's own words aren't shown. The first
   dialect-specific event decides which dialect we send. *Hold to talk*
   enables the microphone track only while the button is held; *Mute*
   disables it.
4. **Delegation:** the request text is the delegation's text (Codex) or
   the user's words since the last delegation (GPT-Live sends none; we
   wait until no words arrived for 700 ms, at most 2.5 s). A running typed
   turn is stopped first. The request runs through `handleUserMessage()` like
   a typed message, with a turn ID, tool cards and history, and with
   `voice: true` (a context line asks for a short, speakable answer).
   As Codex sends a `transcript_delta` with each handoff, the turns said
   since the last delegation (the user's and the voice's, from the
   transcript events) go with the request as a context line, so a request
   can build on what the voice asked first. The chat shows the user's
   turns before the request; the request's own sentence is dropped when
   it repeats the delegation text.
   Text before a tool call and each tool call go back as progress
   (`session.thinking.append`, or Codex `delegation.context.append` on
   the `commentary` channel); the final answer as text to speak
   (`session.commentary.append`, ≤1500 characters each; Codex `speakable`,
   ≤500 bytes each). Answers over 3000 characters are cut and end with
   "The full answer is in the chat." An `ask_user` question ends the
   voice turn as its answer, as Codex's background agent ends its task
   with a question: nothing waits (the tool result says the answer comes
   next), the voice speaks it, and the user's reply is a new delegation
   with the question in its context.
5. **Steering:** a new delegation while the voice turn runs doesn't stop
   it. `AgentLoop.steer()` queues the request; after the current step's
   tool results the loop adds it to that user message ("[The user added
   while you were working:] …", with the voice context line) and the
   chat shows it as a user message
   without a turn ID. Progress and the answer go to the newest
   delegation. A request queued after the turn's last step runs as the
   next turn. The voice instructions say a running task stays steerable
   (as in Codex's prompt): the voice model hands over additions and
   corrections at once instead of waiting. Typing works the same way
   (see *Typing while an answer runs* below).
6. **End:** **End**, a conversation switch, a new chat, Clear, closing the
   view or unloading sends `session.close`, waits up to 5 s for
   `session.closed`, then closes the connection and stops the microphone.
   A running turn finishes in the chat but isn't spoken. If the server
   ends the session (e.g. `expired`) or the connection fails, the chat
   shows why (on mobile in the background: see *Back from the
   background*).

With the *Debug log* setting on, `debug.log` gets every data-channel
event type and its keys (`VOICE_EVENT`), what was sent (`VOICE_SEND`),
the call ID, channel and connection states, and `VOICE_NO_EVENTS` when
nothing arrived within 10 s of the channel opening.

## Back from the background (ADR-15)

A phone suspends or ends Obsidian in the background; nothing tries to
keep running there. `platform/lifecycle.ts` follows the hints (document
`visibilitychange`, Capacitor `pause`/`resume`, window `focus` and
`pageshow`), records when the app went away, and tells listeners when it
is back and for how long. Leaving saves the chats.

**A turn that was running** (`AgentLoop.loop()`):

1. A request fails, and the app was in the background at some time since
   it started (`hiddenSince(start)`), or its stream was cut off (it ended
   before the provider said the answer was complete, with no provider
   error: `StreamCutError`, e.g. a dropped connection, also in the
   foreground); the turn wasn't stopped. In
   `api/stream.ts` a `fetch` that failed that way neither falls back to
   `requestUrl()` nor marks the URL fetch-blocked; it just fails.
2. The loop waits for the app to return (`whenVisible()`), then calls
   `onResuming`: the view removes the failed attempt's streamed text and
   shows "Resuming…" in the thinking indicator.
3. It sends the same request again: same messages (the history holds every
   completed step, tool results included), no new user message, the same
   turn ID. At most 2 resumes per turn; after that the error shows as
   usual. Any other failure in the foreground is an error as before.
4. **Stall** (mobile only): each request has its own abort controller.
   When the app returns while a request is open, the loop aborts that
   request if no data arrives for 10 s (from the return, or from its last
   data if later; `lastChunkAt()`); step 1 then resends it. A
   `requestUrl()` request is raced against the abort, so a hung one is
   abandoned (its native request goes on, its result is ignored). A
   desktop window keeps its requests running, so it isn't watched.

**Obsidian was ended** (iOS may end the web view in the background; the
next start is a fresh load):

1. While a turn runs, its conversation carries `pendingTurn` (turn ID,
   start time); it is saved with the chat when the app goes away, with the
   API history so far (completed tool results included). The turn's end,
   Stop, Clear, a new chat and switching remove it.
2. On load, if the active conversation has the marker and its API history
   ends in a user message or tool results (the model owes an answer), a
   bar above the input says "The last answer was interrupted." with
   **Continue**. Nothing happens automatically.
3. **Continue** runs `AgentLoop.continueTurn()` through the view's normal
   turn path (thinking indicator, tool cards, answer, history, save): the
   loop starts from the saved history; tool results already there are sent,
   not run again. A new message dismisses the bar.

**Voice** (mobile only; a minimised desktop window keeps the call):

1. Leaving turns the microphone track off (it records only silence in the
   background) and starts a 60 s timer. A call lost meanwhile isn't
   reported.
2. Back within 20 s with the peer connection `connected` and the data
   channel open: the microphone returns as it was (off for hold to talk).
3. Back later, or with the call lost: the old call ends quietly and a new
   one starts, shown as "Reconnecting…", seeded with the chat as it is now
   (an answer that finished meanwhile is included) and keeping the mute.
   If it fails, the usual error shows.
4. After 60 s in the background the call ends, also where JavaScript still
   runs (Android): nobody hears it, and it is billed by the minute. Coming
   back later finds no voice bar.

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
     levels (`capabilities.effort`). OpenAI's list has only IDs and
     creation dates, in no order, and every model of the account (speech,
     images, embeddings, voice): keep the chat families, newest first
     (`created`), and drop a dated snapshot (`gpt-5.4-2026-03-05`) when its
     model (`gpt-5.4`) is listed too.
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
