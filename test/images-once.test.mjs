// chat-state.json holds each attached image once (in the API
// history); the visible history keeps names and is filled from the API
// history on load, or shows a placeholder chip when it was trimmed.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, text, response, transport, chatSetup } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  globalThis.__notices = [];
});

const picture = (id, data) => ({ id, fileName: `${id}.png`, mediaType: 'image/png', data, sizeBytes: data.length });
const one = picture('one', `ONE${'x'.repeat(500)}`);
const two = picture('two', `TWO${'y'.repeat(500)}`);
const count = (haystack, needle) => haystack.split(needle).length - 1;
const answering = () => transport((body, index) => response('anthropic', [text(`A${index + 1}`)]));
// The image blocks of the Anthropic request's last user message.
const sentImages = body => body.messages.at(-1).content.filter?.(block => block.type === 'image') ?? [];

test('The saved chat holds each image\'s data once, in the API history', async () => {
  const { plugin, view, writes } = await chatSetup('anthropic');
  answering();
  await view.handleUserMessage('Look at these', null, [one, two]);
  const saved = writes.at(-1);
  const json = JSON.stringify(saved);
  assert.equal(saved.version, api.chatState.CHAT_STATE_VERSION);
  assert.equal(count(json, one.data), 1);
  assert.equal(count(json, two.data), 1);
  const entry = saved.conversations[0].chatHistory.find(e => e.type === 'user');
  assert.deepEqual(entry.images, [
    { id: 'one', fileName: 'one.png', mediaType: 'image/png', sizeBytes: one.sizeBytes },
    { id: 'two', fileName: 'two.png', mediaType: 'image/png', sizeBytes: two.sizeBytes },
  ]);
  // In memory the view keeps showing the images.
  assert.equal(plugin.chatHistory[0].images[0].data, one.data);
});

test('After a reload the images are shown again and regenerate sends them', async () => {
  const first = await chatSetup('anthropic');
  answering();
  await first.view.handleUserMessage('Look at these', null, [one, two]);
  const { view, chat, plugin } = await chatSetup('anthropic', first.writes.at(-1));
  view.renderHistory();
  const shown = chat.shown.find(m => m.type === 'user');
  assert.deepEqual(shown.images.map(image => image.data), [one.data, two.data]);
  assert.deepEqual(plugin.chatHistory[0].images.map(image => image.fileName), ['one.png', 'two.png']);

  const requests = answering();
  await view.regenerate();
  assert.deepEqual(sentImages(requests[0]).map(block => block.source.data), [one.data, two.data]);
});

test('An image the API history no longer holds is a placeholder and isn\'t sent again', async () => {
  // The first turn was trimmed from the API history.
  const saved = {
    version: 2,
    chatHistory: [
      { type: 'user', text: 'Old picture', turnId: 't1', images: [{ id: 'one', fileName: 'one.png', mediaType: 'image/png', sizeBytes: 3 }] },
      { type: 'assistant', text: 'Old answer' },
      { type: 'user', text: 'Recent', turnId: 't2' },
      { type: 'assistant', text: 'New answer' },
    ],
    agentMessages: [{ role: 'user', content: 'ctx\n\nRecent', turnId: 't2' }, { role: 'assistant', content: [text('New answer')] }],
  };
  const { view, chat, plugin } = await chatSetup('anthropic', saved);
  view.renderHistory();
  const [placeholder] = chat.shown.find(m => m.type === 'user').images;
  assert.equal(placeholder.fileName, 'one.png');
  assert.equal(placeholder.data, '');

  const requests = answering();
  await view.editMessage('t1', 'Old picture, again');
  assert.deepEqual(sentImages(requests[0]), []);
  assert.equal(plugin.chatHistory[0].images.length, 0);
});

test('A legacy chat (no version) is migrated once: turn IDs, image data only in the API history', async () => {
  const legacy = {
    chatHistory: [
      { type: 'user', text: 'Trimmed', images: [two] }, { type: 'assistant', text: 'A0' },
      { type: 'user', text: 'With image', images: [one] }, { type: 'assistant', text: 'A1' },
    ],
    agentMessages: [
      { role: 'user', content: [{ type: 'image', image: one }, text('ctx\n\nWith image')] },
      { role: 'assistant', content: [text('A1')] },
    ],
  };
  const { plugin, view, chat, writes } = await chatSetup('anthropic', JSON.parse(JSON.stringify(legacy)));
  view.renderHistory();
  const users = chat.shown.filter(m => m.type === 'user');
  assert.equal(users[1].images[0].data, one.data);
  assert.equal(users[0].images[0].data, ''); // only in the old visible history: dropped
  assert.ok(plugin.chatHistory.every(e => e.type !== 'user' || e.turnId));

  await plugin.saveChatHistory();
  const json = JSON.stringify(writes.at(-1));
  assert.equal(writes.at(-1).version, api.chatState.CHAT_STATE_VERSION);
  assert.equal(count(json, one.data), 1);
  assert.equal(count(json, two.data), 0);

  // A version 2 state isn't stripped again (that migration ran already).
  const v2 = { version: 2, chatHistory: [{ type: 'user', text: 'Q', images: [one] }], agentMessages: [] };
  assert.deepEqual(api.chatState.migrateChatState(v2).conversations[0].chatHistory, v2.chatHistory);
});
