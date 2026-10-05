# GAP-011: Saved chat history stores every image twice

`chat-state.json` holds each attached image's base64 data in two places.

- **Where:** `saveChatHistory()` in `src/main.ts`
- **Impact:** medium; the file grows by megabytes per image and is rewritten
  after every turn

## Problem

The saved state contains the visible history (`chatHistory`, with image
data) and the API history (`agentMessages`, whose image blocks hold the
same data). A message with 4 images of up to 5 MB adds about 2 × 27 MB of
base64.

## Fix

- Keep image data only in the API history, and only the image names in the
  visible history. Show a placeholder when replaying.
- Consider writing attachments to separate files and storing references,
  which matters more once there are many conversations (GAP-008).
- Reference implementation: `writeConversationState()` in
  [nagisa525/obsidian-chatting-plus](https://github.com/nagisa525/obsidian-chatting-plus).
