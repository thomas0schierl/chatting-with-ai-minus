// ask_user with questions and answer options, as Codex's
// request_user_input_async: the call returns at once, the questions wait in
// the conversation's queue, and once all have an answer they go to the model
// as one user message in Codex's reply envelope (into the running turn, or
// as the next turn); the chat shows it as Codex does.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, response, transport, vaultApp, chatFiles, streamEvents, sse } from './harness.mjs';

const { parseQuestions, queuedQuestions, allAnswered, answersMessage, questionReplies, withoutReplies, shownText, savedQuestions, spokenQuestion, QUESTIONS_ASKED } = api.questions;

// The reply envelope of [question, id, answer] triples, as Codex sends it.
const envelope = replies => `<send_user_message_question_reply>\n${JSON.stringify(replies.map(([question, questionItemId, answer]) => ({ answer, question, questionItemId })))}\n</send_user_message_question_reply>`;

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

const scope = { id: 'scope', header: 'Scope', question: 'Which notes should I tag?', options: [
  { label: 'This folder (Recommended)', description: 'Only Projects, quick to check.' },
  { label: 'Whole vault', description: 'Every note, takes longer.' },
] };
const format = { id: 'format', header: 'Format', question: 'Tags or properties?', options: [{ label: 'Tags' }, { label: 'Properties' }] };

test('A call asks 1 to 3 questions; each needs its text, IDs are made unique, at most 4 options', () => {
  assert.equal(parseQuestions(undefined), undefined);
  assert.match(parseQuestions([]), /1 to 3/);
  assert.match(parseQuestions([scope, scope, scope, scope]), /another call/);
  assert.match(parseQuestions([{ id: 'x', options: [] }]), /Question 1 has no 'question'/);
  const parsed = parseQuestions([
    { question: ' First? ', options: [{ label: 'A' }, { label: '' }, { description: 'no label' }, 'B'] },
    { id: 'same', question: 'Second?' }, { id: 'same', question: 'Third?', options: Array.from({ length: 6 }, (_, i) => ({ label: `O${i}` })) },
  ]);
  assert.deepEqual(parsed.map(q => q.id), ['question_1', 'same', 'same_3']);
  assert.equal(parsed[0].question, 'First?');
  assert.deepEqual(parsed[0].options, [{ label: 'A' }]);
  assert.equal(parsed[2].options.length, 4);
});

test('The answers go as one message once all have one, in Codex\'s envelope: the label, the typed answer, empty when skipped', () => {
  const queue = queuedQuestions(parseQuestions([scope, format, { ...format, id: 'own', question: 'Anything else?' }]), 'turn-1');
  assert.equal(new Set(queue.map(q => q.key)).size, 3);
  assert.equal(allAnswered(queue), false);
  queue[0].answer = { label: 'Whole vault' };
  queue[1].answer = null;
  assert.equal(allAnswered(queue), false);
  queue[2].answer = { note: 'Not the Archive' };
  assert.equal(allAnswered(queue), true);
  const message = answersMessage(queue);
  assert.equal(message, envelope([['Which notes should I tag?', 'scope', 'Whole vault'], ['Tags or properties?', 'format', ''], ['Anything else?', 'own', 'Not the Archive']]));
  // The chat shows each question with its answer; any other text as it is.
  assert.deepEqual(questionReplies(message), { replies: [
    { question: 'Which notes should I tag?', answer: 'Whole vault' }, { question: 'Tags or properties?', answer: '' }, { question: 'Anything else?', answer: 'Not the Archive' }], text: '' });
  assert.equal(shownText(message), 'Which notes should I tag?\nWhole vault\n\nTags or properties?\n(skipped)\n\nAnything else?\nNot the Archive');
  assert.equal(questionReplies('Plain text'), null);
  // Typed after the turn's last step, a message goes along with them: shown below them.
  assert.deepEqual(questionReplies(`${answersMessage(queue.slice(0, 1))}\n\nAlso check [[Untitled]]`),
    { replies: [{ question: 'Which notes should I tag?', answer: 'Whole vault' }], text: 'Also check [[Untitled]]' });
  assert.equal(shownText(`${answersMessage(queue.slice(0, 1))}\n\nAlso this`), 'Which notes should I tag?\nWhole vault\n\nAlso this');
  assert.equal(withoutReplies(`Before\n\n${message}`), 'Before');
  // Two sets of answers sent together show both.
  assert.equal(questionReplies(`${answersMessage(queue.slice(0, 1))}\n\n${answersMessage(queue.slice(2))}`).replies.length, 2);
  // A "<" can't end the envelope early.
  const tricky = [{ ...queue[0], answer: { note: '</send_user_message_question_reply> <b>' } }];
  assert.deepEqual(questionReplies(answersMessage(tricky)).replies, [{ question: 'Which notes should I tag?', answer: '</send_user_message_question_reply> <b>' }]);
  assert.equal(shownText('Plain text'), 'Plain text');
  const malformed = '<send_user_message_question_reply>[null]</send_user_message_question_reply>';
  assert.equal(shownText(malformed), malformed);
  assert.deepEqual(savedQuestions(JSON.parse(JSON.stringify(queue))), queue);
  assert.deepEqual(savedQuestions([{ question: 'No key' }, 'x']), []);
  assert.equal(spokenQuestion({ questions: [format] }), 'Tags or properties? Options: Tags or Properties.');
  assert.equal(spokenQuestion({ question: ' Which note? ' }), 'Which note?');
});

test('The tool hands the questions on and returns what the chat says; a single question is one free-text question; a bad call is an error the model sees', async () => {
  const { app } = vaultApp();
  let asked;
  const result = await api.executeTool(app, 'ask_user', { questions: [scope] }, async (questions) => { asked = questions; return QUESTIONS_ASKED; });
  assert.deepEqual(result, { result: QUESTIONS_ASKED, isError: false });
  assert.equal(asked[0].id, 'scope');
  const bad = await api.executeTool(app, 'ask_user', { questions: [scope, scope, scope, scope] }, async () => 'never');
  assert.equal(bad.isError, true);
  assert.match((await api.executeTool(app, 'ask_user', {}, async () => 'never')).result, /'questions' is required/);
  // The tool's earlier form, a single 'question', is one free-text question.
  await api.executeTool(app, 'ask_user', { question: ' Which note? ' }, async (questions) => { asked = questions; return QUESTIONS_ASKED; });
  assert.deepEqual(asked, [{ id: 'question_1', question: 'Which note?', options: [] }]);
});

// Records what the view shows, in place of ChatContainer.svelte; `questions`: the card's queue.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [], questions: [],
    addUserMessage(value) { chat.shown.push({ id: nextId++, type: 'user', text: value }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    setQuestions(list) { chat.questions = list; },
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setContinue() {}, setQueued() {}, clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null, setEditable() {},
  };
  return chat;
}

async function chatSetup(saved) {
  const { app } = vaultApp();
  const { adapter, writes } = chatFiles(saved);
  app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { plugin, view, chat, writes };
}

async function until(condition) {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), 'timed out');
}

const lastUserText = body => {
  const content = body.messages.at(-1).content;
  return typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n');
};

test('Asking doesn\'t wait: the turn goes on, the queue is saved, and the answers start the next turn once all have one', async () => {
  const { plugin, view, chat, writes } = await chatSetup();
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [text('Two questions first.'), call('ask', 'ask_user', { questions: [scope, format] })], 'tool_use')
    : response('anthropic', [text(index === 1 ? 'Drafted meanwhile.' : 'Tagged.')]));
  await view.handleUserMessage('Tag my notes', null);
  assert.equal(requests.length, 2);
  const result = requests[1].messages.at(-1).content.find(block => block.type === 'tool_result').content;
  assert.equal(result, QUESTIONS_ASKED);
  // The text before the call and the step show; the questions wait in the card.
  assert.deepEqual(plugin.chatHistory.map(e => e.type), ['user', 'assistant', 'tool-result', 'assistant']);
  assert.deepEqual(chat.questions.map(q => q.id), ['scope', 'format']);
  await until(() => writes.length >= 1);
  const restored = await chatSetup(JSON.parse(JSON.stringify(writes.at(-1))));
  assert.deepEqual(restored.plugin.activeConversation.questions.map(q => q.id), ['scope', 'format']);

  // The second answered first: nothing goes yet; the first then sends both.
  view.answerQuestion(chat.questions[1].key, null);
  assert.equal(requests.length, 2);
  assert.equal(chat.questions[1].answer, null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  assert.deepEqual(chat.questions, []);
  await until(() => requests.length === 3 && !view.running);
  const answers = envelope([['Which notes should I tag?', 'scope', 'Whole vault'], ['Tags or properties?', 'format', '']]);
  assert.ok(lastUserText(requests[2]).endsWith(`\n\n${answers}`));
  // Delivered: out of the card, kept (saved) until their asking turn goes.
  assert.ok(plugin.activeConversation.questions.every(q => q.delivered));
  assert.deepEqual(chat.questions, []);
  assert.deepEqual(plugin.chatHistory.slice(-2).map(e => [e.type, e.text]),
    [['user', answers], ['assistant', 'Tagged.']]);
});

test('Answered while the agent works, the answers go into the running turn; more questions join the queue meanwhile', async () => {
  const { plugin, view, chat } = await chatSetup();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = transport(async (body, index) => {
    if (index === 0) return response('anthropic', [call('ask1', 'ask_user', { questions: [scope] })], 'tool_use');
    if (index === 1) return response('anthropic', [call('ask2', 'ask_user', { questions: [format] })], 'tool_use');
    if (index === 2) { await held; return response('anthropic', [call('now', 'get_current_datetime', {})], 'tool_use'); }
    return response('anthropic', [text('Done.')]);
  });
  const running = view.handleUserMessage('Tag my notes', null);
  await until(() => requests.length === 3);
  assert.deepEqual(chat.questions.map(q => q.id), ['scope', 'format']);
  view.answerQuestion(chat.questions[0].key, { label: 'This folder (Recommended)' });
  view.answerQuestion(chat.questions[1].key, { note: 'Both' });
  release();
  await running;
  assert.equal(requests.length, 4);
  assert.ok(lastUserText(requests[3]).endsWith(`[The user added while you were working:] ${envelope([['Which notes should I tag?', 'scope', 'This folder (Recommended)'], ['Tags or properties?', 'format', 'Both']])}`));
  assert.ok(plugin.activeConversation.questions.every(q => q.delivered));
  assert.deepEqual(chat.questions, []);
});

test('Stop keeps the questions; editing the turn that asked them drops them', async () => {
  const { plugin, view, chat } = await chatSetup();
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : index === 1 ? new Promise(() => {}) : response('anthropic', [text('Fine.')]));
  void view.handleUserMessage('Tag my notes', null);
  await until(() => requests.length === 2);
  view.handleStop();
  assert.equal(chat.questions.length, 1);
  assert.equal(plugin.activeConversation.questions.length, 1);
  const turnId = plugin.chatHistory.find(e => e.type === 'user').turnId;
  await view.editMessage(turnId, 'Tag my notes, no questions');
  assert.deepEqual(chat.questions, []);
  assert.equal(plugin.activeConversation.questions, undefined);
});

test("Answers that don't reach the model come back to the card with their answers, never into the input; saved until the model has them", async () => {
  const { plugin, view, chat, writes } = await chatSetup();
  chat.restoreDraft = (value) => { chat.draft = value; };
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : index === 1 ? new Promise(() => {}) : response('anthropic', [text('Tagged.')]));
  void view.handleUserMessage('Tag my notes', null);
  await until(() => requests.length === 2);
  // Sent into the running turn, then Stop before the agent took them in.
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  assert.deepEqual(chat.questions, []);
  // Saved with their answers meanwhile: Obsidian ended now, they come back after the restart.
  await until(() => writes.at(-1)?.conversations?.[0]?.questions?.[0]?.answer?.label === 'Whole vault');
  view.handleStop();
  assert.equal(chat.draft, undefined);
  assert.deepEqual(chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  assert.deepEqual(plugin.activeConversation.questions.map(q => q.answer), [{ label: 'Whole vault' }]);

  // While an undo runs they wait in the card; sent again afterwards, they start the next turn.
  view.undoing = true;
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  assert.equal(chat.questions.length, 1);
  assert.equal(chat.draft, undefined);
  assert.ok(globalThis.__notices.some(notice => notice.includes('wait')));
  view.undoing = false;
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => requests.length === 3 && !view.running);
  assert.ok(lastUserText(requests[2]).endsWith(envelope([['Which notes should I tag?', 'scope', 'Whole vault']])));
  assert.ok(plugin.activeConversation.questions.every(q => q.delivered));
  assert.deepEqual(chat.questions, []);
});

test("Links and /skills in the questions or answers aren't read: only what the user typed counts", async () => {
  const { view, chat } = await chatSetup();
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [{ id: 'note', question: 'Tag [[Untitled]] too?', options: [{ label: 'Yes' }] }] })], 'tool_use')
    : response('anthropic', [text('Fine.')]));
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { note: 'Yes, and [[Untitled]]' });
  await until(() => requests.length === 3 && !view.running);
  assert.ok(!lastUserText(requests[2]).includes('Original'));
});

test('Answers refused before any request (the 30 MB limit) are back in the card', async () => {
  const { plugin, view, chat } = await chatSetup();
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : response('anthropic', [text('Ok.')]));
  await view.handleUserMessage('Tag my notes', null);
  plugin.agent.messages.push({ role: 'user', content: 'x'.repeat(31_000_000) }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => !view.running);
  assert.equal(requests.length, 2);
  assert.deepEqual(chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  assert.equal(plugin.activeConversation.questions[0].delivered, undefined);
});

test('Regenerating the turn the answers were steered into brings them back to the card', async () => {
  const { plugin, view, chat } = await chatSetup();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = transport(async (body, index) => {
    if (index === 0) return response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use');
    if (index === 1) return response('anthropic', [text('Waiting for your answer.')]);
    if (index === 2) { await held; return response('anthropic', [call('now', 'get_current_datetime', {})], 'tool_use'); }
    return response('anthropic', [text('Done.')]);
  });
  await view.handleUserMessage('Tag my notes', null);
  const running = view.handleUserMessage('Also fix typos', null);
  await until(() => requests.length === 3);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  release();
  await running;
  assert.ok(lastUserText(requests[3]).includes('send_user_message_question_reply'));
  assert.deepEqual(chat.questions, []);
  await view.regenerate();
  assert.deepEqual(chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  assert.equal(plugin.activeConversation.questions[0].delivered, undefined);
});

test('Stopped after the loop took the answers message (its request on the way), they stay delivered (no second copy)', async () => {
  const { plugin, view, chat } = await chatSetup();
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : index === 2 ? new Promise(() => {}) : response('anthropic', [text('Ok.')]));
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => requests.length === 3);
  view.handleStop();
  assert.deepEqual(chat.questions, []);
  assert.ok(plugin.activeConversation.questions.every(q => q.delivered));
});

// An Anthropic answer whose request was compacted on the provider's side.
function compacted(summary, blocks, stop = 'end_turn') {
  const events = streamEvents('anthropic', blocks, stop);
  for (const event of events) if (typeof event.index === 'number') event.index += 1;
  events.splice(1, 0, { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: summary } },
    { type: 'content_block_stop', index: 0 });
  return sse(events);
}

test('Answers stay delivered when the history is compacted, natively or by Compact now, and after a later regenerate', async () => {
  const { plugin, view, chat } = await chatSetup();
  const requests = transport((body, index) => {
    if (index === 0) return response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use');
    if (index === 1) return response('anthropic', [text('Waiting.')]);
    if (index === 2) return compacted('Summary of all so far.', [call('ask2', 'ask_user', { questions: [format] })], 'tool_use');
    return response('anthropic', [text(`R${index}`)]);
  });
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => requests.length === 4 && !view.running);
  // The answers turn's response compacted everything before it: still delivered.
  assert.deepEqual(chat.questions.map(q => q.id), ['format']);
  view.answerQuestion(chat.questions[0].key, { label: 'Tags' });
  await until(() => requests.length === 5 && !view.running);
  assert.ok(!lastUserText(requests[4]).includes('"questionItemId":"scope"'));
  await view.compactNow();
  await view.handleUserMessage('Next thing', null);
  await view.regenerate();
  assert.deepEqual(chat.questions, []);
});

test('A question asked again gets its own ID, so its answer is sent, not taken for the earlier one', async () => {
  const { view, chat } = await chatSetup();
  const go = { id: 'go', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = transport(async (body, index) => {
    if (index === 0) return response('anthropic', [call('ask', 'ask_user', { questions: [go] })], 'tool_use');
    if (index === 1) return response('anthropic', [text('Waiting.')]);
    if (index === 2) return response('anthropic', [text('Done 1.')]);
    if (index === 3) return response('anthropic', [call('ask2', 'ask_user', { questions: [go, format] })], 'tool_use');
    if (index === 4) { await held; return response('anthropic', [text('Waiting again.')]); }
    return response('anthropic', [text('Final.')]);
  });
  await view.handleUserMessage('Do step 1', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Yes' });
  await until(() => !view.running && requests.length === 3);
  const running = view.handleUserMessage('Do step 2', null);
  await until(() => requests.length === 5);
  assert.deepEqual(chat.questions.map(q => q.id), ['go_2', 'format']);
  view.answerQuestion(chat.questions[0].key, { label: 'Yes' });
  release();
  await running;
  view.answerQuestion(chat.questions.find(q => q.id === 'format').key, { label: 'Tags' });
  await until(() => !view.running && requests.length === 6);
  assert.ok(lastUserText(requests[5]).includes('"questionItemId":"go_2"'));
});

test("Switching to a chat whose turn runs shows that chat's questions", async () => {
  const { plugin, view, chat } = await chatSetup();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  transport(async (body) => {
    const typed = lastUserText(body);
    if (typed.includes('Chat A')) return response('anthropic', [call('askA', 'ask_user', { questions: [scope] })], 'tool_use');
    if (typed.includes('Chat B')) return response('anthropic', [call('askB', 'ask_user', { questions: [format] })], 'tool_use');
    if (JSON.stringify(body).includes('Chat B')) { await held; return response('anthropic', [text('B done')]); }
    return response('anthropic', [text('ok')]);
  });
  await view.handleUserMessage('Chat A', null);
  const a = plugin.activeConversationId;
  view.newChat();
  const running = view.handleUserMessage('Chat B', null);
  await until(() => chat.questions.some(q => q.id === 'format'));
  const b = plugin.activeConversationId;
  await view.openConversation(a);
  assert.deepEqual(chat.questions.map(q => q.id), ['scope']);
  await view.openConversation(b);
  assert.deepEqual(chat.questions.map(q => q.id), ['format']);
  release();
  await running;
});

test('An answers message edited to other answers replaces them: the old ones stay out of the card', async () => {
  const { plugin, view, chat } = await chatSetup();
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : response('anthropic', [text(`R${index}`)]));
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => !view.running && requests.length === 3);
  const answersTurn = plugin.chatHistory.filter(row => row.type === 'user' && row.turnId).at(-1).turnId;
  await view.editMessage(answersTurn, 'Which notes should I tag?\nOnly Projects');
  assert.deepEqual(chat.questions, []);
  assert.ok(plugin.activeConversation.questions.every(q => q.delivered));
});

// Holds the loop at its summary check before a turn, before the model's history took the message.
function holdRetain(agent) {
  const prepare = agent.prepareContext.bind(agent);
  let release;
  let entered = false;
  const held = new Promise(resolve => { release = resolve; });
  agent.prepareContext = async (...args) => { entered = true; await held; return prepare(...args); };
  return { entered: () => entered, release: () => { release(); agent.prepareContext = prepare; } };
}

test('Stopped after its turn began but before the model took it (a summary written first), the answers message was not sent: back in the card', async () => {
  const { plugin, view, chat } = await chatSetup();
  chat.restoreDraft = (value) => { chat.draft = value; };
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : response('anthropic', [text(`R${index}`)]));
  await view.handleUserMessage('Tag my notes', null);
  const hold = holdRetain(plugin.agent);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(hold.entered);
  view.handleStop();
  hold.release();
  assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && /question_reply/.test(row.text ?? '')).length, 0);
  assert.deepEqual(chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  assert.equal(chat.draft, undefined);
  assert.equal(requests.length, 2);
});

test('A question asked again after its answers turn was regenerated gets its own ID too', async () => {
  const { view, chat } = await chatSetup();
  const go = { id: 'go', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] };
  const requests = transport((body, index) => {
    if (index === 0) return response('anthropic', [call('ask', 'ask_user', { questions: [go] })], 'tool_use');
    if (index === 3) return response('anthropic', [call('ask2', 'ask_user', { questions: [go, format] })], 'tool_use');
    return response('anthropic', [text(`R${index}`)]);
  });
  await view.handleUserMessage('Do it', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Yes' });
  await until(() => !view.running && requests.length === 3);
  await view.regenerate();
  await until(() => !view.running && requests.length === 5);
  assert.deepEqual(chat.questions.map(q => q.id), ['go_2', 'format']);
  view.answerQuestion(chat.questions[0].key, { label: 'Yes' });
  view.answerQuestion(chat.questions[1].key, { label: 'Tags' });
  await until(() => !view.running && requests.length === 6);
  assert.ok(lastUserText(requests[5]).includes('"questionItemId":"go_2"'));
});


test('Stopped after a compaction in the answers turn, the answers count as sent (not back in the card)', async () => {
  const { view, chat } = await chatSetup();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = transport(async (body, index) => {
    if (index === 0) return response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use');
    if (index === 1) return response('anthropic', [text('Waiting')]);
    if (index === 2) return compacted('Earlier summary', [text('Tagging.'), call('t1', 'get_current_datetime', {})], 'tool_use');
    await held;
    return response('anthropic', [text('done')]);
  });
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => requests.length === 4);
  view.handleStop();
  release();
  await until(() => !view.running);
  assert.deepEqual(chat.questions, []);
});

test('A message stopped before the model took it keeps its undo notes for the next one; Clear brings nothing back', async () => {
  const { plugin, view, chat } = await chatSetup();
  chat.restoreDraft = (value) => { chat.draft = value; };
  const requests = transport(async () => response('anthropic', [text('ok')]));
  await view.handleUserMessage('First', null);
  plugin.activeConversation.notes = ['The user undid the changes to A.md'];
  let hold = holdRetain(plugin.agent);
  let run = view.handleUserMessage('Second', null);
  await until(hold.entered);
  view.handleStop();
  hold.release();
  await run;
  assert.equal(chat.draft, 'Second');
  assert.deepEqual(plugin.activeConversation.notes, ['The user undid the changes to A.md']);
  await view.handleUserMessage(chat.draft, null);
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1).content), /undid/);

  chat.draft = undefined;
  hold = holdRetain(plugin.agent);
  run = view.handleUserMessage('Typed then cleared', null);
  await until(hold.entered);
  view.handleClear();
  hold.release();
  await run;
  assert.equal(chat.draft, undefined);
});

test('Obsidian ended before the model took the answers message: after the restart they are back in the card', async () => {
  const { plugin, view, chat, writes } = await chatSetup();
  transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : response('anthropic', [text(`R${index}`)]));
  await view.handleUserMessage('Tag my notes', null);
  const hold = holdRetain(plugin.agent);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(hold.entered);
  // Saved on the way to the background, then ended.
  await plugin.saveChatHistory();
  const restored = await chatSetup(JSON.parse(JSON.stringify(writes.at(-1))));
  restored.view.renderHistory();
  assert.deepEqual(restored.chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  // For good: its row is gone, so the next message or a switch doesn't count it as sent.
  assert.equal(restored.plugin.chatHistory.some(row => /question_reply/.test(row.text ?? '')), false);
  assert.equal(restored.plugin.activeConversation.pendingTurn, undefined);
  await restored.view.handleUserMessage('Something else', null);
  assert.deepEqual(restored.chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  hold.release();
  view.handleStop();
});

test('A regenerated answers message cut off before the loop took it: after the restart the answers are back in the card', async () => {
  const { plugin, view, chat, writes } = await chatSetup();
  transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : response('anthropic', [text(`R${index}`)]));
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => plugin.chatHistory.some(row => row.type === 'assistant' && row.text === 'R2') && !view.running);
  const hold = holdRetain(plugin.agent);
  const run = view.regenerate();
  await until(hold.entered);
  await plugin.saveChatHistory();
  const restored = await chatSetup(JSON.parse(JSON.stringify(writes.at(-1))));
  restored.view.renderHistory();
  assert.deepEqual(restored.chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  hold.release();
  view.handleStop();
  await run;
});

test('An answers message edited to other text and cut off before the loop took it: after the restart the answers are back, the edit noted', async () => {
  const { plugin, view, chat, writes } = await chatSetup();
  transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : response('anthropic', [text(`R${index}`)]));
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => plugin.chatHistory.some(row => row.type === 'assistant' && row.text === 'R2') && !view.running);
  const answersTurn = plugin.chatHistory.filter(row => row.type === 'user' && row.turnId).at(-1).turnId;
  const hold = holdRetain(plugin.agent);
  const run = view.editMessage(answersTurn, 'Which notes should I tag?\nOnly Projects');
  await until(hold.entered);
  await plugin.saveChatHistory();
  const restored = await chatSetup(JSON.parse(JSON.stringify(writes.at(-1))));
  restored.view.renderHistory();
  assert.deepEqual(restored.chat.questions.map(q => q.answer), [{ label: 'Whole vault' }]);
  assert.match(restored.plugin.chatHistory.at(-1).text, /wasn't sent: "Which notes should I tag\?\nOnly Projects"/);
  hold.release();
  view.handleStop();
  await run;
});

test('Answers an edit replaced stay delivered through a later regenerate or edit', async () => {
  const { plugin, view, chat } = await chatSetup();
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { questions: [scope] })], 'tool_use')
    : response('anthropic', [text(`R${index}`)]));
  await view.handleUserMessage('Tag my notes', null);
  view.answerQuestion(chat.questions[0].key, { label: 'Whole vault' });
  await until(() => !view.running && requests.length === 3);
  const answersTurn = plugin.chatHistory.filter(row => row.type === 'user' && row.turnId).at(-1).turnId;
  await view.editMessage(answersTurn, 'Which notes should I tag?\nOnly Projects');
  assert.deepEqual(chat.questions, []);
  await view.regenerate();
  assert.deepEqual(chat.questions, []);
  await view.handleUserMessage('Next', null);
  const next = plugin.chatHistory.filter(row => row.type === 'user' && row.turnId).at(-1).turnId;
  await view.editMessage(next, 'Next, edited');
  assert.deepEqual(chat.questions, []);
});
