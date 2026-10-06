// The screen stays on while an answer is generated or a call runs; Stop
// before any answer text says so.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, transport, response, text, chatSetup } from './harness.mjs';

const { screenAwake } = api;
const { appLifecycle } = api.lifecycle;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let requests;
let locks;
beforeEach(() => {
  requests = 0;
  locks = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      wakeLock: {
        request: async (type) => {
          assert.equal(type, 'screen');
          requests++;
          const lock = { released: false, release: async () => { lock.released = true; } };
          locks.push(lock);
          return lock;
        },
      },
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'document', { value: { visibilityState: 'visible' }, configurable: true, writable: true });
});

afterEach(() => {
  screenAwake.reset();
  delete globalThis.document;
});

test('One lock while anyone holds it; released when the last one lets go', async () => {
  const first = screenAwake.hold();
  const second = screenAwake.hold();
  await tick();
  assert.equal(requests, 1);
  first();
  first(); // letting go twice counts once
  await tick();
  assert.equal(locks[0].released, false);
  second();
  await tick();
  assert.equal(locks[0].released, true);
});

test('The system drops the lock in the background; it is asked for again on the return', async () => {
  const release = screenAwake.hold();
  await tick();
  appLifecycle.markHidden();
  locks[0].released = true;
  appLifecycle.markVisible();
  await tick();
  assert.equal(requests, 2);
  release();
  await tick();
  assert.equal(locks[1].released, true);
});

test('Without the API nothing happens', async () => {
  globalThis.navigator = {};
  const release = screenAwake.hold();
  await tick();
  release();
  assert.equal(requests, 0);
});

test('A turn holds the screen on until it ends', async () => {
  const { view } = await chatSetup('anthropic');
  let answer;
  transport(() => new Promise((resolve) => { answer = () => resolve(response('anthropic', [text('Done')])); }));
  const turn = view.handleUserMessage('Q', null);
  while (!answer) await tick();
  assert.equal(requests, 1);
  assert.equal(locks[0].released, false);
  answer();
  await turn;
  await tick();
  assert.equal(locks[0].released, true);
});

test('Stop before any answer text leaves a quiet "Stopped." note', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  let started = false;
  transport(() => { started = true; return new Promise(() => {}); });
  void view.handleUserMessage('Q', null);
  while (!started) await tick();
  view.handleStop();
  const note = chat.shown.at(-1);
  assert.equal(note.type, 'error');
  assert.equal(note.errorKind, 'stopped');
  assert.equal(note.text, 'Stopped.');
  assert.equal(plugin.chatHistory.at(-1).errorKind, 'stopped');
});
