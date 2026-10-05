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
   Codex adapter.
3. Create the `AgentLoop` with the shared settings object.
4. `loadChatHistory()`: read `chat-state.json` and import the messages
   (trimmed to 40).
5. Register the settings tab, view, ribbon icon, commands and menus.

No network requests happen at start.

## Sending a message

1. **Send:** the user presses Enter or Send (or a command such as *Chat
   about this note*). `chat-view.ts` shows the message, saves it to the UI
   history and calls `AgentLoop.run(text, callbacks, selection, images)`.
2. **Turn setup:** `run()` takes a snapshot of the settings, so provider
   and model stay fixed for the turn. It adds the context prefix (and the
   selection-scope instruction), appends the user message, and trims the
   history if it is over 50 messages.
3. **Loop, up to the iteration limit:**
   1. Show the thinking indicator.
   2. Call `client.sendMessage()`, which sends through the provider's
      adapter.
   3. If the answer was cut off by the token limit, show an error and stop;
      tool calls from a cut-off answer never run.
   4. Store the assistant message, including the provider's native items
      for replay.
   5. If there are no tool calls: show the text and end the turn. Anthropic
      `pause_turn` continues instead.
   6. Otherwise, first store placeholder results ("cancelled"), then run
      the tools one by one, replacing each placeholder with the real
      result. This keeps every call paired with a result even if the user
      presses Stop.
4. **Finish:** the view re-enables input and saves the chat history after
   every turn.

**Stop:** sets a flag and a new run version. A request already sent can't
be cancelled, but its result is ignored.

**`ask_user`:** shows the question; the user's next input becomes the tool
result instead of a new message.

## Provider requests

| | Anthropic | OpenAI | ChatGPT / Codex |
|---|---|---|---|
| History sent | All messages; native blocks (thinking signatures, search results) replayed when provider, model and key are unchanged | Only new items, chained with `previous_response_id`; full replay after model or key changes, restore, or trimming | Full replay every turn (`store: false`) |
| Thinking | Adaptive for Opus/Sonnet 4.6+, fixed budget for older Opus/Sonnet, none otherwise (TD-006) | `reasoning.effort: medium` for reasoning-capable names (TD-006) | From the model catalog; fallback `medium` |
| Response | JSON | JSON | SSE, buffered by `requestUrl()` and parsed afterwards |
| Caching | `cache_control` on the system prompt and last tool | provider-side | provider-side |

## ChatGPT sign-in (`auth/chatgptOAuth.ts`)

1. **Connect:** *Connect ChatGPT* calls `beginDeviceAuthorization()`
   (`POST …/deviceauth/usercode`), which returns a user code.
2. **Login page:** the modal shows the code and a link to
   `auth.openai.com/codex/device`.
3. **Poll:** `pollDeviceAuthorization()` polls `…/deviceauth/token` until
   the user has signed in. It then exchanges the authorization code at
   `/oauth/token` and stores the credential (with the account ID from the
   ID token) in SecretStorage.
4. **Refresh:** before each request, `getUsableCredential()` refreshes the
   token if it expires within 30 seconds.

## Model list refresh (`api/model-catalog.ts`)

1. **Trigger:** opening settings shows the cached list. If it is older than
   24 hours it refreshes in the background; the refresh button forces it.
2. **Cache key:** the hash of provider plus API key or ChatGPT account, so
   switching accounts never shows another account's list.
3. **Fetch:**
   - **ChatGPT:** first look up the latest stable Codex version on GitHub
     (cached for 24 hours), then fetch `/codex/models` and keep the models
     marked `list`.
   - **Anthropic, OpenAI:** fetch `/v1/models`.
4. **Result:** the new list is saved to `data.json`. On failure the last
   list is kept, and there are no retries for 5 minutes.
