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
4. `loadChatHistory()`: read `chat-state.json` and import the messages
   (trimmed to 40). Turns saved without a turn ID get one in both
   histories (`assignLegacyTurnIds()`, paired from the end; see *Editing a
   message*). Until this has finished, `saveChatHistory()` does nothing, so
   an early unload can't overwrite the saved chat.
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
result instead of a new message.

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
   images and selection scope, as in *Sending a message*. The context
   prefix (active note) is the current one.

- **Providers:** the request after a cut sends the cut history. OpenAI
  finds no response to chain to for the new array and replays in full,
  without `previous_response_id`; chaining resumes with the next turn.
- **Not undone:** notes the AI created or changed after that point stay as
  they are. The removed continuation is gone; there are no branches.
- **Saved without IDs:** each turn added one user entry and one turn
  start, so `assignLegacyTurnIds()` pairs them from the end. Where one
  history reaches further back, its older turns get IDs of their own.

**Copy:** the action under each finished answer copies its Markdown
source (the text as received, before math conversion) and shows
"Copied". Answers still streaming have no actions.

## Provider requests

| | Anthropic | OpenAI | ChatGPT |
|---|---|---|---|
| History sent | All messages; native blocks (thinking signatures, search results) replayed when provider, model and key are unchanged | Only new items, chained with `previous_response_id`; full replay after model or key changes, restore, trimming, or a cut (edit, regenerate) | Full replay every turn (`store: false`, no `previous_response_id`); function tools inside the `vault` namespace |
| Request headers | `anthropic-dangerous-direct-browser-access: true` (CORS for `fetch`) | | |
| Thinking | From the model catalog: `thinking` adaptive or fixed budget (8192 tokens); `output_config.effort` only when the chosen level is offered. None without catalog data | None; `/v1/models` reports no reasoning data | From the model catalog: `reasoning.effort` = chosen level if offered, else the model's default; `summary` unless the model rejects it. None without catalog data |
| Response | SSE (`stream: true`); content blocks rebuilt from `content_block_*` events (text, thinking and signature deltas, tool input JSON, citations); done only at `message_stop` | SSE (`stream: true`); `response.output_text.delta` for text, items from `response.output_item.done`; done only at `response.completed` | same as OpenAI (the route requires `stream: true`) |
| Images in tool results | `image` blocks inside the `tool_result` content | `function_call_output.output` as an array of `input_text` and `input_image` (data URL) | same as OpenAI |
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
   sign-in; network and server errors keep it.
6. **Disconnect:** `signOut()` revokes the refresh token (one retry after
   a network error or 5xx), then clears the tokens. The host and client ID
   stay for the next sign-in.

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
