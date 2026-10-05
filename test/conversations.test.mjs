// Named conversations: the chat-state.json version 3 format and its
// migration, create/switch/rename/delete through the real chat view (fake
// Svelte component), restore on load, titles, and that histories and
// OpenAI chaining stay within their conversation.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, image, response, transport, vaultApp, chatSetup } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  globalThis.__notices = [];
});

const { CHAT_STATE_VERSION, migrateChatState, NEW_CHAT_TITLE } = api.chatState;
// Answers each request with "A<n>" (n counts requests).
const answering = provider => transport((body, index) => response(provider, [text(`A${index + 1}`)], 'end_turn', index));
// Anthropic request: the user turns' texts, without the context prefix.
const userTurns = body => body.messages.filter(m => m.role === 'user' && (typeof m.content === 'string' || m.content.some(b => b.type === 'text')))
  .map(m => (typeof m.content === 'string' ? m.content : m.content.find(b => b.type === 'text').text).split('\n').at(-1));
// OpenAI request: the texts of its input items, without the context prefix.
const inputTexts = body => body.input.flatMap(item => item.content ?? []).map(part => part.text.split('\n').at(-1));
const shownTexts = chat => chat.shown.map(m => m.text);
const titles = plugin => plugin.listConversations().map(c => c.title);
const tick = () => new Promise(resolve => setTimeout(resolve, 2));

test('A version 1 or 2 chat becomes the first, active conversation', async () => {
  const chatHistory = [{ type: 'user', text: 'Old question', turnId: 't1' }, { type: 'assistant', text: 'Old answer' }];
  const agentMessages = [{ role: 'user', content: 'ctx\n\nOld question', turnId: 't1' }, { role: 'assistant', content: [text('Old answer')] }];
  for (const saved of [{ chatHistory, agentMessages }, { version: 2, chatHistory, agentMessages }]) {
    const state = migrateChatState(JSON.parse(JSON.stringify(saved)));
    assert.equal(state.version, CHAT_STATE_VERSION);
    assert.equal(state.conversations.length, 1);
    const [conversation] = state.conversations;
    assert.equal(state.activeConversationId, conversation.id);
    assert.equal(conversation.title, 'Old question');
    assert.equal(conversation.customTitle, false);
    assert.deepEqual(conversation.chatHistory.map(e => e.text), ['Old question', 'Old answer']);
    assert.equal(conversation.agentMessages.length, 2);
  }

  const { plugin, view, chat, writes } = await chatSetup('anthropic', { chatHistory, agentMessages });
  view.renderHistory();
  assert.deepEqual(shownTexts(chat), ['Old question', 'Old answer']);
  const requests = answering('anthropic');
  await view.handleUserMessage('Next', null);
  assert.deepEqual(userTurns(requests[0]), ['Old question', 'Next']);
  const saved = writes.at(-1);
  assert.equal(saved.version, 3);
  assert.equal(saved.conversations.length, 1);
  assert.equal(saved.activeConversationId, plugin.activeConversationId);
  assert.equal('chatHistory' in saved, false);
  // Version 3 isn't migrated again.
  assert.deepEqual(migrateChatState(saved).conversations.map(c => c.id), [saved.activeConversationId]);
});

test('New chat, switch, rename and delete', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('First topic', null);
  const first = plugin.activeConversationId;
  assert.equal(chat.title, 'First topic');

  view.newChat();
  const second = plugin.activeConversationId;
  assert.notEqual(second, first);
  assert.deepEqual(chat.shown, []);
  assert.equal(chat.title, NEW_CHAT_TITLE);
  // An empty new chat isn't listed, and New chat again keeps it.
  assert.deepEqual(titles(plugin), ['First topic']);
  view.newChat();
  assert.equal(plugin.activeConversationId, second);

  await tick();
  await view.handleUserMessage('Second topic', null);
  assert.deepEqual(titles(plugin), ['Second topic', 'First topic']);
  assert.deepEqual(plugin.listConversations().map(c => c.active), [true, false]);

  view.openConversation(first);
  assert.equal(plugin.activeConversationId, first);
  assert.deepEqual(shownTexts(chat), ['First topic', 'A1']);
  assert.equal(chat.title, 'First topic');
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['First topic', 'A1']);

  // Rename: kept over later turns; an empty name goes back to the automatic title.
  view.renameConversation(first, '  My   own name ');
  assert.equal(chat.title, 'My own name');
  await view.handleUserMessage('More', null);
  assert.deepEqual(titles(plugin), ['My own name', 'Second topic']);
  view.renameConversation(first, '   ');
  assert.deepEqual(titles(plugin), ['First topic', 'Second topic']);

  // Deleting another conversation leaves the current one alone.
  view.deleteConversation(second);
  assert.equal(plugin.activeConversationId, first);
  assert.deepEqual(titles(plugin), ['First topic']);
  assert.deepEqual(shownTexts(chat), ['First topic', 'A1', 'More', 'A3']);
});

test('Deleting the current conversation opens the most recent other; deleting the last leaves an empty new one', async () => {
  const { plugin, view, chat, writes } = await chatSetup('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Older', null);
  const older = plugin.activeConversationId;
  view.newChat();
  await tick();
  await view.handleUserMessage('Newer', null);
  view.newChat();
  await tick();
  await view.handleUserMessage('Newest', null);
  const newest = plugin.activeConversationId;

  view.deleteConversation(newest);
  assert.deepEqual(shownTexts(chat), ['Newer', 'A2']);
  assert.deepEqual(titles(plugin), ['Newer', 'Older']);
  view.deleteConversation(plugin.activeConversationId);
  assert.equal(plugin.activeConversationId, older);
  assert.deepEqual(shownTexts(chat), ['Older', 'A1']);

  view.deleteConversation(older);
  assert.deepEqual(chat.shown, []);
  assert.equal(chat.title, NEW_CHAT_TITLE);
  assert.deepEqual(titles(plugin), []);
  assert.equal(plugin.conversations.length, 1);
  await tick();
  const saved = writes.at(-1);
  assert.equal(saved.conversations.length, 1);
  assert.deepEqual(saved.conversations[0].chatHistory, []);
  assert.equal(saved.activeConversationId, plugin.activeConversationId);

  // The empty conversation works like a fresh chat.
  await view.handleUserMessage('Fresh', null);
  assert.deepEqual(userTurns(requests.at(-1)), ['Fresh']);
});

test('The last active conversation is restored on load, with its own API history', async () => {
  const first = await chatSetup('anthropic');
  answering('anthropic');
  await first.view.handleUserMessage('Topic A', null);
  const a = first.plugin.activeConversationId;
  first.view.newChat();
  await tick();
  await first.view.handleUserMessage('Topic B', null);
  first.view.openConversation(a);
  await first.plugin.saveChatHistory();

  const { plugin, view, chat } = await chatSetup('anthropic', first.writes.at(-1));
  assert.equal(plugin.activeConversationId, a);
  view.renderHistory();
  assert.deepEqual(shownTexts(chat), ['Topic A', 'A1']);
  assert.deepEqual(titles(plugin), ['Topic B', 'Topic A']);
  const requests = answering('anthropic');
  await view.handleUserMessage('Back to A', null);
  assert.deepEqual(userTurns(requests[0]), ['Topic A', 'Back to A']);
});

test('Titles: first user message, one line, at most 40 characters; edits update them, renames stay', async () => {
  const long = 'Please   summarise\nthe meeting notes from yesterday and list every open action item';
  assert.equal(api.chatState.conversationTitle([{ type: 'user', text: long }]), 'Please summarise the meeting notes from…');
  assert.equal(api.chatState.conversationTitle([{ type: 'user', text: long }]).length, 40);
  assert.equal(api.chatState.conversationTitle([{ type: 'user', text: '', images: [{ fileName: 'photo.jpg' }] }]), 'photo.jpg');
  assert.equal(api.chatState.conversationTitle([]), NEW_CHAT_TITLE);

  const { plugin, view, writes } = await chatSetup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Original question', null);
  await view.handleUserMessage('Follow-up', null);
  await view.editMessage(plugin.chatHistory[0].turnId, 'Edited question');
  assert.equal(plugin.activeConversation.title, 'Edited question');

  view.renameConversation(plugin.activeConversationId, 'Named');
  await tick();
  const restored = await chatSetup('anthropic', writes.at(-1));
  assert.equal(restored.plugin.activeConversation.title, 'Named');
  assert.equal(restored.plugin.activeConversation.customTitle, true);
});

test('OpenAI: histories and response chaining stay within their conversation', async () => {
  const { plugin, view } = await chatSetup('openai');
  const requests = answering('openai');
  await view.handleUserMessage('Q1', null);
  await view.handleUserMessage('Q2', null);
  assert.equal(requests[1].previous_response_id, 'resp_0');
  const a = plugin.activeConversationId;

  view.newChat();
  await view.handleUserMessage('B1', null);
  assert.equal(requests[2].previous_response_id, undefined);
  assert.deepEqual(inputTexts(requests[2]), ['B1']);
  await view.handleUserMessage('B2', null);
  assert.equal(requests[3].previous_response_id, 'resp_2');

  view.openConversation(a);
  await view.handleUserMessage('Q3', null);
  assert.equal(requests[4].previous_response_id, undefined);
  assert.deepEqual(inputTexts(requests[4]), ['Q1', 'A1', 'Q2', 'A2', 'Q3']);
  await view.handleUserMessage('Q4', null);
  assert.equal(requests[5].previous_response_id, 'resp_4');

  // Back and forth: the first request after each switch replays only that conversation.
  const b = plugin.listConversations().find(c => !c.active).id;
  for (const [id, question, expected] of [[b, 'B3', ['B1', 'A3', 'B2', 'A4', 'B3']], [a, 'Q5', ['Q1', 'A1', 'Q2', 'A2', 'Q3', 'A5', 'Q4', 'A6', 'Q5']]]) {
    view.openConversation(id);
    await view.handleUserMessage(question, null);
    assert.equal(requests.at(-1).previous_response_id, undefined);
    assert.deepEqual(inputTexts(requests.at(-1)), expected);
  }
});

test('OpenAI: after a restart the open conversation replays in full once, then chains again', async () => {
  const first = await chatSetup('openai');
  answering('openai');
  await first.view.handleUserMessage('Q1', null);
  first.view.newChat();
  await first.view.handleUserMessage('Other', null);
  const restored = await chatSetup('openai', first.writes.at(-1));
  const requests = answering('openai');
  await restored.view.handleUserMessage('After restart', null);
  assert.equal(requests[0].previous_response_id, undefined);
  assert.deepEqual(inputTexts(requests[0]), ['Other', 'A2', 'After restart']);
  await restored.view.handleUserMessage('Next', null);
  assert.equal(requests[1].previous_response_id, 'resp_0');
});

test('"Chat about this note" and "Send selection to chat" start a new conversation', async () => {
  globalThis.window ??= globalThis;
  const { plugin, view, chat } = await chatSetup('anthropic');
  const requests = answering('anthropic');
  plugin.isProviderConfigured = () => true;
  plugin.activateView = async () => view;
  plugin.getChatView = () => view;
  await view.handleUserMessage('Earlier topic', null);
  const earlier = plugin.activeConversationId;

  await plugin.openChatWithMessage('Tell me about Notes/Plan.md');
  while (requests.length < 2 || view.running) await tick();
  assert.notEqual(plugin.activeConversationId, earlier);
  assert.deepEqual(userTurns(requests[1]), ['Tell me about Notes/Plan.md']);
  assert.deepEqual(titles(plugin), ['Tell me about Notes/Plan.md', 'Earlier topic']);

  const selected = [];
  chat.setSelection = selection => selected.push(selection);
  const noteChat = plugin.activeConversationId;
  await plugin.openChatWithSelection({ text: 'Some words', filePath: 'Notes/Plan.md' });
  assert.notEqual(plugin.activeConversationId, noteChat);
  assert.deepEqual(chat.shown, []);
  assert.deepEqual(selected, [{ text: 'Some words', filePath: 'Notes/Plan.md' }]);
});

test('Commands act on the chat view as soon as its UI is mounted, not after a fixed delay', async () => {
  const { plugin, view, chat, app } = await chatSetup('anthropic');
  plugin.isProviderConfigured = () => true;
  const revealed = [];
  app.workspace.getLeavesOfType = () => [{ view }];
  app.workspace.revealLeaf = async leaf => { revealed.push(leaf); };
  const selected = [];
  chat.setSelection = selection => selected.push(selection);

  const opening = plugin.openChatWithSelection({ text: 'Words', filePath: 'Plan.md' });
  await tick();
  assert.equal(revealed.length, 1);
  assert.deepEqual(selected, []);
  view.markReady();
  await opening;
  assert.deepEqual(selected, [{ text: 'Words', filePath: 'Plan.md' }]);
});

test('Switching stops a running turn; it ends in its own conversation', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use')
    : response('anthropic', [text(`A${index + 1}`)]));
  const asking = view.handleUserMessage('Waiting question', null);
  while (!chat.askUser) await tick();
  const a = plugin.activeConversationId;

  view.newChat();
  assert.equal(view.running, false);
  assert.deepEqual(chat.shown, []);
  await asking;
  assert.deepEqual(plugin.chatHistory, []);
  assert.equal(plugin.agent.exportMessages().length, 0);

  await view.handleUserMessage('Other topic', null);
  assert.equal(requests.length, 2);
  assert.deepEqual(userTurns(requests[1]), ['Other topic']);

  view.openConversation(a);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Waiting question', 'Which note?']);
  // The stopped tool call keeps its (cancelled) result, so the conversation goes on.
  await view.handleUserMessage('Go on', null);
  assert.deepEqual(userTurns(requests[2]), ['Waiting question', 'Go on']);
});

test('Edit and regenerate work within the conversation they belong to', async () => {
  const { plugin, view } = await chatSetup('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Q1', null);
  await view.handleUserMessage('Q2', null);
  const a = plugin.activeConversationId;
  const q2 = plugin.chatHistory[2].turnId;
  view.newChat();
  await view.handleUserMessage('Other', null);
  const b = plugin.activeConversationId;

  view.openConversation(a);
  await view.editMessage(q2, 'Q2 edited');
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2 edited']);
  await view.regenerate();
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2 edited']);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Q1', 'A1', 'Q2 edited', `A${requests.length}`]);

  view.openConversation(b);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Other', 'A3']);
});

test('Each conversation is saved with its own caps (100 entries, 80 API messages)', async () => {
  const { plugin, view, writes } = await chatSetup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Current', null);
  const big = api.chatState.newConversation(1);
  for (let i = 0; i < 60; i++) {
    big.chatHistory.push({ type: 'user', text: `Q${i}`, turnId: `t${i}` }, { type: 'assistant', text: `A${i}` });
    big.agentMessages.push({ role: 'user', content: `Q${i}`, turnId: `t${i}` }, { role: 'assistant', content: [text(`A${i}`)] });
  }
  plugin.conversations.push(big);
  await plugin.saveChatHistory();
  const saved = writes.at(-1).conversations.find(c => c.id === big.id);
  assert.equal(saved.chatHistory.length, 100);
  assert.equal(saved.chatHistory[0].text, 'Q10');
  assert.equal(saved.agentMessages.length, 80);
  assert.equal(saved.agentMessages[0].turnId, 't20');
  assert.equal(writes.at(-1).conversations.length, 2);
});

test('Switching away and back keeps the API history up to 80 messages, and its images', async () => {
  const { plugin, view, writes } = await chatSetup('anthropic');
  const requests = answering('anthropic');
  const long = plugin.activeConversation;
  for (let i = 0; i < 35; i++) {
    const images = i === 0 ? [{ ...image, id: 'old-image' }] : [];
    long.chatHistory.push({ type: 'user', text: `Q${i}`, turnId: `t${i}`, images }, { type: 'assistant', text: `A${i}` });
    const content = i === 0 ? [{ type: 'image', image: images[0] }, text(`Q${i}`)] : `Q${i}`;
    long.agentMessages.push({ role: 'user', content, turnId: `t${i}` }, { role: 'assistant', content: [text(`A${i}`)] });
  }
  plugin.agent.importMessages(long.agentMessages);

  view.newChat();
  view.openConversation(long.id);
  assert.equal(plugin.agent.exportMessages().length, 70);
  await view.handleUserMessage('Next', null);
  assert.equal(requests[0].messages.length, 71);

  // Saved and loaded again: the oldest turn and its image are still there.
  await new Promise(resolve => setTimeout(resolve, 2));
  const restored = await chatSetup('anthropic', JSON.parse(JSON.stringify(writes.at(-1))));
  assert.equal(restored.plugin.agent.exportMessages().length, 72);
  assert.equal(restored.plugin.chatHistory[0].images[0].data, image.data);
});

test('Nothing is saved before the saved conversations have been read', async () => {
  const { app } = vaultApp();
  const writes = [];
  let finishRead;
  app.vault.adapter = { read: () => new Promise(resolve => { finishRead = resolve; }), write: async (path, data) => { writes.push(JSON.parse(data)); } };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  const loading = plugin.loadChatHistory();
  plugin.onunload();
  await plugin.saveChatHistory();
  assert.deepEqual(writes, []);

  const conversation = (id, question, updatedAt) => ({
    id, title: question, customTitle: false, createdAt: 1, updatedAt,
    chatHistory: [{ type: 'user', text: question, turnId: `${id}-t` }],
    agentMessages: [{ role: 'user', content: question, turnId: `${id}-t` }],
  });
  finishRead(JSON.stringify({ version: 3, activeConversationId: 'b', conversations: [conversation('a', 'First', 2), conversation('b', 'Second', 1)] }));
  await loading;
  assert.equal(plugin.activeConversationId, 'b');
  await plugin.saveChatHistory();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].conversations.map(c => c.chatHistory[0].text), ['First', 'Second']);
  assert.equal(writes[0].activeConversationId, 'b');
});

test('Tool cards keep their (capped) input across a reload; old cards without input still show', async () => {
  const { plugin, view, writes } = await chatSetup('anthropic');
  const input = { path: 'Untitled.md', note: 'x'.repeat(1000), lines: Array.from({ length: 15 }, (_, i) => i) };
  transport((body, index) => index === 0
    ? response('anthropic', [call('r', 'read_file', input)], 'tool_use')
    : response('anthropic', [text('Read it')]));
  await view.handleUserMessage('Read the note', null);
  const card = plugin.chatHistory.find(e => e.type === 'tool-result');
  assert.equal(card.toolInput.path, 'Untitled.md');
  assert.equal(card.toolInput.note, `${'x'.repeat(300)}… (1000 characters)`);
  assert.deepEqual(card.toolInput.lines, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, '… (5 more)']);
  // The API history keeps the full input.
  assert.equal(plugin.agent.exportMessages()[1].content[0].input.note.length, 1000);

  const saved = writes.at(-1);
  saved.conversations[0].chatHistory.push({ type: 'tool-result', toolName: 'list_files', toolResult: { result: 'old', isError: false } });
  const reloaded = await chatSetup('anthropic', saved);
  reloaded.view.renderHistory();
  const cards = reloaded.chat.shown.filter(m => m.type === 'tool-result');
  assert.deepEqual(cards.map(m => m.toolInput), [card.toolInput, {}]);
});

// A plugin whose chat-state.json holds `content` (undefined: no file), with a
// fake adapter that records writes and renames.
async function loadFrom(content, { renameFails = false } = {}) {
  const { app } = vaultApp();
  const writes = [], renames = [];
  app.vault.adapter = {
    read: async () => { if (content === undefined) throw new Error('ENOENT'); return content; },
    exists: async () => content !== undefined,
    rename: async (from, to) => { if (renameFails) throw new Error('EBUSY'); renames.push([from, to]); },
    write: async (path, data) => { writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  await plugin.loadChatHistory();
  return { plugin, writes, renames };
}

test('An unreadable chat-state.json is kept aside before starting fresh, with one notice', async () => {
  for (const content of ['{"version": 3, "conversations": [', '[]', 'null']) {
    globalThis.__notices = [];
    const { plugin, writes, renames } = await loadFrom(content);
    assert.equal(renames.length, 1);
    assert.equal(renames[0][0], '.obsidian/plugins/chatting-with-ai-minus/chat-state.json');
    assert.match(renames[0][1], /^\.obsidian\/plugins\/chatting-with-ai-minus\/chat-state\.corrupt-\d+\.json$/);
    assert.equal(globalThis.__notices.length, 1);
    assert.match(globalThis.__notices[0], /couldn't be read.*chat-state\.corrupt-\d+\.json/);
    // The fresh chat is saved to a new file; the old one is safe.
    await plugin.saveChatHistory();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].conversations[0].chatHistory, []);
  }
});

test('An unreadable chat-state.json that can\'t be moved aside is never overwritten', async () => {
  const { plugin, writes } = await loadFrom('not json', { renameFails: true });
  assert.equal(globalThis.__notices.length, 1);
  assert.match(globalThis.__notices[0], /aren't saved until Obsidian restarts/);
  plugin.chatHistory.push({ type: 'user', text: 'New', turnId: 't' });
  await plugin.saveChatHistory();
  assert.deepEqual(writes, []);
});

test('No chat-state.json yet (first run): no notice, nothing renamed, saving works', async () => {
  const { plugin, writes, renames } = await loadFrom(undefined);
  assert.deepEqual(renames, []);
  assert.deepEqual(globalThis.__notices, []);
  await plugin.saveChatHistory();
  assert.equal(writes.length, 1);
});

test('Saves never overlap: calls during a write share one next write with the latest state', async () => {
  const { app } = vaultApp();
  const writes = [], pending = [];
  let active = 0, maxActive = 0;
  app.vault.adapter = {
    read: async () => { throw new Error('ENOENT'); },
    exists: async () => false,
    write: (path, data) => {
      active++;
      maxActive = Math.max(maxActive, active);
      writes.push(JSON.parse(data));
      return new Promise(resolve => pending.push(() => { active--; resolve(); }));
    },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  await plugin.loadChatHistory();

  const first = plugin.saveChatHistory();
  assert.equal(writes.length, 1);
  plugin.chatHistory.push({ type: 'user', text: 'One', turnId: 't1' });
  const second = plugin.saveChatHistory();
  plugin.chatHistory.push({ type: 'user', text: 'Two', turnId: 't2' });
  const third = plugin.saveChatHistory();
  assert.equal(second, third);
  assert.equal(writes.length, 1);

  pending.shift()();
  await first;
  while (writes.length < 2) await tick();
  assert.deepEqual(writes[1].conversations[0].chatHistory.map(e => e.text), ['One', 'Two']);
  pending.shift()();
  await third;
  assert.equal(writes.length, 2);
  assert.equal(maxActive, 1);

  // Idle again: the next save writes at once.
  void plugin.saveChatHistory();
  assert.equal(writes.length, 3);
  pending.shift()();
});
