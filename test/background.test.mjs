// Back from the background (ADR-15): the foreground/background hints, a
// request that failed or stalled while Obsidian was away resumed in the
// same turn, and Continue after the phone ended Obsidian mid-turn.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, chatSetup } from './harness.mjs';

const { AppLifecycle, appLifecycle } = api.lifecycle;

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  appLifecycle.markVisible();
});
afterEach(() => {
  delete globalThis.__fetch;
  delete globalThis.document;
  api.Platform.isMobileApp = false;
});

/** A fake document and window, and an owner that records the listeners the way registerDomEvent does. */
function hintSources() {
  const doc = { visibilityState: 'visible' };
  const win = {};
  const listeners = [];
  const owner = { registerDomEvent: (target, type, listener) => listeners.push({ target, type, listener }) };
  const fire = (target, type) => {
    for (const entry of listeners) if (entry.target === target && entry.type === type) entry.listener();
  };
  return { doc, win, owner, listeners, fire };
}

// ─── Hints ──────────────────────────────────────────────────────────────────

test('Lifecycle: visibilitychange, pause/resume, focus and pageshow decide hidden and visible; repeats count once', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const lifecycle = new AppLifecycle();
  const { doc, win, owner, listeners, fire } = hintSources();
  lifecycle.watch(owner, doc, win);
  assert.deepEqual(listeners.map(l => [l.target === doc ? 'document' : 'window', l.type]),
    [['document', 'visibilitychange'], ['document', 'pause'], ['document', 'resume'], ['window', 'focus'], ['window', 'pageshow']]);
  const events = [];
  lifecycle.onHidden(() => events.push('hidden'));
  lifecycle.onVisible(ms => events.push(`visible after ${ms}`));

  assert.equal(lifecycle.isHidden(), false);
  assert.equal(lifecycle.hiddenSince(0), false);
  await lifecycle.whenVisible();

  const before = now;
  now += 10;
  doc.visibilityState = 'hidden';
  fire(doc, 'visibilitychange');
  fire(doc, 'pause');
  assert.equal(lifecycle.isHidden(), true);
  assert.equal(lifecycle.hiddenSince(before), true);
  let back = false;
  const waiting = lifecycle.whenVisible().then(() => { back = true; });
  // Focus while the page says hidden isn't a return.
  fire(win, 'focus');
  await Promise.resolve();
  assert.equal(back, false);

  now += 5_000;
  fire(doc, 'resume');
  await waiting;
  assert.equal(back, true);
  assert.equal(lifecycle.isHidden(), false);
  assert.equal(lifecycle.hiddenSince(before), true);
  assert.equal(lifecycle.hiddenSince(now + 1), false);

  fire(doc, 'pause');
  now += 100;
  doc.visibilityState = 'visible';
  fire(win, 'pageshow');
  fire(win, 'focus');
  fire(doc, 'visibilitychange');
  assert.deepEqual(events, ['hidden', 'visible after 5000', 'hidden', 'visible after 100']);
});

test('Leaving Obsidian saves the chats (the phone may end it in the background)', async () => {
  const { plugin, writes } = await chatSetup('anthropic');
  globalThis.document = { visibilityState: 'visible' };
  const { owner, listeners } = hintSources();
  const cleanups = [];
  plugin.registerDomEvent = owner.registerDomEvent;
  plugin.register = cleanup => cleanups.push(cleanup);
  plugin.watchLifecycle();
  assert.equal(listeners.length, 5);
  appLifecycle.markHidden();
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(writes.length, 1);
  for (const cleanup of cleanups) cleanup();
  appLifecycle.markVisible();
  appLifecycle.markHidden();
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(writes.length, 1);
});
