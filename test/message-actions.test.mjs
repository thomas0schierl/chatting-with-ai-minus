// Editing a message and continuing, copying and regenerating an answer:
// both histories cut at the same turn, through the real chat view with a
// fake Svelte component.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, image, text, call, response, transport, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  globalThis.__notices = [];
});

// Stands in for ChatContainer.svelte: keeps the shown messages like it does.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    assistantAdds: [],
    askUser: null,
    addUserMessage(value, images = [], turnId, selection) { chat.shown.push({ id: nextId++, type: 'user', text: value, images, turnId, selection }); },
    addAssistantMessage(value, streaming = false) {
      chat.assistantAdds.push({ text: value, streaming });
      chat.shown.push({ id: nextId, type: 'assistant', text: value, streaming });
      return nextId++;
    },
    updateAssistantMessage(id, value, final = false) {
      const msg = chat.shown.find(m => m.id === id);
      if (msg) { msg.text = value; if (final) msg.streaming = false; }
    },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) {
      const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId);
      if (index >= 0) chat.shown.splice(index);
    },
    addToolCall(name) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    showAskUser(question) { chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy(value) { chat.busy = value; },
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin with a fresh (or the given saved) chat, its view, and the saved states.
async function setup(provider, saved) {
  const { app, files } = vaultApp();
  const writes = [];
  app.vault.adapter = {
    append: async () => {},
    read: async () => { if (!saved) throw new Error('ENOENT'); return JSON.stringify(saved); },
    write: async (path, data) => { writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings(provider));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { app, files, plugin, view, chat, writes };
}

// Anthropic request: the user turns' texts (without the context prefix) and the tool pairs.
const userTurns = body => body.messages.filter(m => m.role === 'user' && (typeof m.content === 'string' || m.content.some(b => b.type === 'text')))
  .map(m => (typeof m.content === 'string' ? m.content : m.content.find(b => b.type === 'text').text).split('\n').at(-1));
const toolUseIds = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => b.id) : []);
const toolResultIds = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : []);
const turnIdsOf = plugin => ({
  ui: plugin.chatHistory.filter(e => e.type === 'user').map(e => e.turnId),
  agent: plugin.agent.exportMessages().filter(m => m.turnId).map(m => m.turnId),
});
// Answers each request with "A<n>"; the answer to `withTool` first reads a file.
function answering(provider, { withTool } = {}) {
  let answer = 0;
  return transport(body => {
    const last = provider === 'anthropic' ? body.messages.at(-1) : null;
    const question = last && typeof last.content === 'string' ? last.content.split('\n').at(-1) : '';
    if (question === withTool) return response(provider, [text('Reading'), call(`read-${answer}`, 'read_file', { path: 'Untitled.md' })], 'tool_use');
    return response(provider, [text(`A${++answer}`)], 'end_turn', answer);
  });
}

for (const [label, index] of [['first', 0], ['middle', 1], ['last', 2]]) {
  test(`Edit the ${label} turn: both histories are cut there and the edited text runs`, async () => {
    const { plugin, view, chat } = await setup('anthropic');
    const requests = answering('anthropic');
    for (const question of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(question, null);
    const before = turnIdsOf(plugin);
    assert.deepEqual(before.ui, before.agent);
    assert.equal(new Set(before.ui).size, 3);

    await view.editMessage(before.ui[index], 'Edited');
    const kept = ['Q1', 'Q2', 'Q3'].slice(0, index);
    assert.deepEqual(userTurns(requests.at(-1)), [...kept, 'Edited']);
    assert.equal(requests.at(-1).messages.length, 2 * index + 1);
    assert.deepEqual(plugin.chatHistory.map(e => e.text), [...kept.flatMap((q, i) => [q, `A${i + 1}`]), 'Edited', 'A4']);
    const after = turnIdsOf(plugin);
    assert.deepEqual(after.ui, after.agent);
    assert.deepEqual(after.ui.slice(0, index), before.ui.slice(0, index));
    assert.notEqual(after.ui[index], before.ui[index]);
    assert.deepEqual(chat.shown.filter(m => m.type === 'user').map(m => m.text), [...kept, 'Edited']);
  });
}

test('Edit after a turn with tool calls keeps its call/result pairs; editing that turn drops them whole', async () => {
  const { plugin, view } = await setup('anthropic');
  const requests = answering('anthropic', { withTool: 'Q2' });
  for (const question of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(question, null);
  const ids = turnIdsOf(plugin).ui;

  await view.editMessage(ids[2], 'Edited 3');
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2', 'Edited 3']);
  assert.equal(toolUseIds(requests.at(-1)).length, 1);
  assert.deepEqual(toolResultIds(requests.at(-1)), toolUseIds(requests.at(-1)));

  await view.editMessage(ids[1], 'Edited 2');
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Edited 2']);
  assert.deepEqual(toolUseIds(requests.at(-1)), []);
  assert.deepEqual(toolResultIds(requests.at(-1)), []);
  assert.equal(plugin.chatHistory.some(e => e.type === 'tool-result'), false);
});

test('Editing a turn while its tool call waits stops it and cuts before it', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  let runningDuringNewTurn;
  const requests = transport(async (body, index) => {
    if (index === 0) return response('anthropic', [text('A1')]);
    if (index === 1) return response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use');
    // The stopped turn ends while this one runs; it must not end this one's running state.
    await new Promise(resolve => setTimeout(resolve, 10));
    runningDuringNewTurn = view.running;
    return response('anthropic', [text('A2')]);
  });
  await view.handleUserMessage('Q1', null);
  const asking = view.handleUserMessage('Q2', null);
  while (!chat.askUser) await new Promise(resolve => setTimeout(resolve, 1));
  const q2 = turnIdsOf(plugin).ui[1];

  const editing = view.editMessage(q2, 'Q2 again');
  await Promise.all([asking, editing]);
  assert.equal(runningDuringNewTurn, true);
  assert.equal(view.running, false);
  assert.deepEqual(userTurns(requests[2]), ['Q1', 'Q2 again']);
  assert.deepEqual(toolUseIds(requests[2]), []);
  assert.deepEqual(toolResultIds(requests[2]), []);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Q1', 'A1', 'Q2 again', 'A2']);
  assert.deepEqual(chat.shown.map(m => m.text), ['Q1', 'A1', 'Q2 again', 'A2']);
});

test('A chat saved without turn IDs gets matching IDs on load and can be edited', async () => {
  const saved = {
    chatHistory: [
      { type: 'user', text: 'Old Q1' }, { type: 'assistant', text: 'Old A1' },
      { type: 'user', text: 'Old Q2' }, { type: 'tool-result', toolName: 'read_file', toolInput: {}, toolResult: { result: 'x', isError: false } },
      { type: 'assistant', text: 'Old A2' },
    ],
    agentMessages: [
      { role: 'user', content: 'ctx\n\nOld Q1' }, { role: 'assistant', content: [text('Old A1')] },
      { role: 'user', content: 'ctx\n\nOld Q2' }, { role: 'assistant', content: [call('r', 'read_file', { path: 'Untitled.md' })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'x' }] }, { role: 'assistant', content: [text('Old A2')] },
    ],
  };
  const { plugin, view } = await setup('anthropic', saved);
  const ids = turnIdsOf(plugin);
  assert.equal(ids.ui.length, 2);
  assert.deepEqual(ids.ui, ids.agent);
  assert.equal(plugin.agent.exportMessages()[4].turnId, undefined); // tool results are not turn starts

  const requests = answering('anthropic');
  await view.editMessage(ids.ui[1], 'New Q2');
  assert.deepEqual(userTurns(requests[0]), ['Old Q1', 'New Q2']);
  assert.deepEqual(toolUseIds(requests[0]), []);
});

test('A legacy turn older than the saved API history cuts the API history to nothing', async () => {
  // The visible history reaches further back than the trimmed API history.
  const saved = {
    chatHistory: [{ type: 'user', text: 'Ancient' }, { type: 'assistant', text: 'Old' }, { type: 'user', text: 'Recent' }, { type: 'assistant', text: 'New' }],
    agentMessages: [{ role: 'user', content: 'ctx\n\nRecent' }, { role: 'assistant', content: [text('New')] }],
  };
  const { plugin, view } = await setup('anthropic', saved);
  const ids = turnIdsOf(plugin);
  assert.equal(ids.agent.length, 1);
  assert.equal(ids.agent[0], ids.ui[1]);

  const requests = answering('anthropic');
  await view.editMessage(ids.ui[0], 'Ancient, edited');
  assert.deepEqual(userTurns(requests[0]), ['Ancient, edited']);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Ancient, edited', 'A1']);
});

test('The cut is saved at once, and the saved chat after the new turn restores consistently', async () => {
  const { plugin, view, writes } = await setup('anthropic');
  answering('anthropic');
  for (const question of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(question, null);
  const ids = turnIdsOf(plugin).ui;
  const savedBefore = writes.length;

  const editing = view.editMessage(ids[1], 'Edited');
  // Saved before the new turn starts: only the first turn is left.
  assert.deepEqual(writes[savedBefore].chatHistory.map(e => e.text), ['Q1', 'A1']);
  assert.deepEqual(writes[savedBefore].agentMessages.filter(m => m.turnId).map(m => m.turnId), [ids[0]]);
  await editing;

  const final = writes.at(-1);
  assert.deepEqual(final.chatHistory.map(e => e.text), ['Q1', 'A1', 'Edited', 'A4']);
  const restored = await setup('anthropic', JSON.parse(JSON.stringify(final)));
  const restoredIds = turnIdsOf(restored.plugin);
  assert.deepEqual(restoredIds.ui, restoredIds.agent);
  assert.deepEqual(restoredIds.ui, turnIdsOf(plugin).ui);
  const requests = answering('anthropic');
  await restored.view.editMessage(restoredIds.ui[1], 'Edited after restart');
  assert.deepEqual(userTurns(requests[0]), ['Q1', 'Edited after restart']);
});

test('OpenAI: after a cut the next request replays in full, without previous_response_id', async () => {
  const { plugin, view } = await setup('openai');
  const requests = transport((body, index) => response('openai', [text(`A${index + 1}`)], 'end_turn', index));
  await view.handleUserMessage('Q1', null);
  await view.handleUserMessage('Q2', null);
  assert.equal(requests[1].previous_response_id, 'resp_0'); // chained before the cut

  await view.editMessage(turnIdsOf(plugin).ui[1], 'Q2 edited');
  assert.equal(requests[2].previous_response_id, undefined);
  const texts = requests[2].input.flatMap(item => item.content ?? []).map(part => part.text.split('\n').at(-1));
  assert.deepEqual(texts, ['Q1', 'A1', 'Q2 edited']);

  await view.regenerate();
  assert.equal(requests[3].previous_response_id, undefined);
  // Chaining resumes on the cut history.
  await view.handleUserMessage('Q3', null);
  assert.equal(requests[4].previous_response_id, 'resp_3');
});

test('Regenerate runs the last turn again with the same text, images and selection', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Q1', null);
  const selection = { text: 'Selected words', filePath: 'Notes/Draft.md' };
  await view.handleUserMessage('Describe this', selection, [image]);
  const firstRun = requests[1].messages.at(-1).content;

  await view.regenerate();
  const rerun = requests[2].messages.at(-1).content;
  assert.deepEqual(rerun, firstRun);
  assert.equal(rerun[0].type, 'image');
  assert.equal(rerun[0].source.data, image.data);
  assert.match(rerun[1].text, /Selection scope: .*Notes\/Draft\.md[\s\S]*> Selected words[\s\S]*Describe this$/);
  assert.equal(requests[2].messages.length, 3);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Q1', 'A1', 'Describe this', 'A3']);
  const turn = plugin.chatHistory[2];
  assert.deepEqual(turn.images, [image]);
  assert.deepEqual(turn.selection, selection);
  assert.deepEqual(chat.shown.at(-2).images, [image]);
});

test('Copy puts the answer\'s Markdown source on the clipboard', async () => {
  const markdown = '**Bold** and \\(x^2\\)\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const { view, chat } = await setup('anthropic');
  transport(() => response('anthropic', [text(markdown)]));
  await view.handleUserMessage('Q', null);
  // The streamed message starts without actions and ends with the whole source.
  assert.equal(chat.assistantAdds[0].streaming, true);
  const answer = chat.shown.at(-1);
  assert.equal(answer.streaming, false);
  assert.equal(answer.text, markdown);

  const copied = [];
  const clipboard = { writeText: async value => { copied.push(value); } };
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboard, configurable: true });
  else globalThis.navigator = { clipboard };
  view.copyAnswer(answer.text);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(copied, [markdown]);
  assert.deepEqual(globalThis.__notices, ['Copied']);
});
