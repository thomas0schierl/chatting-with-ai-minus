// Typing while an answer runs: the message is added to the running turn
// (taken in after the current step), or runs next if the turn has no step
// left; Stop drops it. Works without streaming: steps are separate requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transport, response, text, call, chatSetup } from './harness.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Sent while a tool step runs: queued, then taken in with the next step, in the same turn', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  let releaseFirst;
  const requests = transport((body, index) => index === 0
    ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
    : response('anthropic', [text('Added both.')]));
  const turn = view.handleUserMessage('Add a Notes section', null);
  while (!releaseFirst) await tick();

  await view.handleUserMessage('Also add notes-notes', null);
  assert.deepEqual(chat.queued, ['Also add notes-notes']);
  releaseFirst();
  await turn;

  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /\[The user added while you were working:\] Also add notes-notes/);
  assert.deepEqual(chat.queued, []);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Add a Notes section', true], ['Also add notes-notes', false]]);
  assert.equal(plugin.chatHistory.at(-1).text, 'Added both.');
});

test('Sent during a turn without another step: runs as the next turn once the answer is in', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  let releaseFirst;
  const requests = transport((body, index) => index === 0
    ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('First.')])); })
    : response('anthropic', [text('Second.')]));
  const turn = view.handleUserMessage('First', null);
  while (!releaseFirst) await tick();
  await view.handleUserMessage('Second', null);
  releaseFirst();
  await turn;
  while (requests.length < 2 || view.running) await tick();

  assert.deepEqual(chat.queued, []);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]), [['First', true], ['Second', true]]);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'assistant').map((e) => e.text), ['First.', 'Second.']);
});

test('Clear during a turn drops what was added: no queued chips, nothing runs in the cleared chat', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  let releaseFirst;
  const requests = transport((body, index) => index === 0
    ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('First.')])); })
    : response('anthropic', [text('Should not run.')]));
  const turn = view.handleUserMessage('First', null);
  while (!releaseFirst) await tick();
  await view.handleUserMessage('Also this', null);
  view.handleClear();
  assert.deepEqual(chat.queued, []);
  releaseFirst();
  await turn;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 1);
  assert.deepEqual(plugin.chatHistory, []);
});

test('Stop drops what was added; nothing runs afterwards', async () => {
  const { view, chat } = await chatSetup('anthropic');
  let started = false;
  const requests = transport(() => { started = true; return new Promise(() => {}); });
  void view.handleUserMessage('First', null);
  while (!started) await tick();
  await view.handleUserMessage('Also this', null);
  assert.deepEqual(chat.queued, ['Also this']);
  view.handleStop();
  await tick();
  assert.deepEqual(chat.queued, []);
  assert.equal(requests.length, 1);
});
