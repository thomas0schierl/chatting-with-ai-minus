// The "Debug log" setting switches logging at runtime; "Copy debug log" gets it off a phone.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings } from './harness.mjs';

const LOG = '.obsidian/plugins/chatting-with-ai-minus/debug.log';

function pluginWith(saved) {
  const files = new Map();
  const adapter = {
    append: async (path, text) => { files.set(path, (files.get(path) ?? '') + text); },
    exists: async (path) => files.has(path),
    read: async (path) => files.get(path),
    remove: async (path) => { files.delete(path); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = { vault: { adapter, configDir: '.obsidian' }, workspace: { getLeavesOfType: () => [] } };
  plugin.loadApiKey = () => '';
  plugin.loadData = async () => ({ ...settings('openai'), ...saved });
  plugin.saveData = async () => {};
  return { plugin, files };
}

let copied;
beforeEach(() => {
  globalThis.__notices = [];
  copied = null;
  // Newer Node versions define a read-only `navigator`; replace it the way a browser test would.
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { copied = text; } } },
    configurable: true,
    writable: true,
  });
});

test('Off by default: nothing is written, and Copy says how to turn it on', async () => {
  const { plugin, files } = pluginWith({});
  await plugin.loadSettings();
  api.debug.debugLog(plugin.app, 'TEST', { a: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(files.has(LOG), false);
  await plugin.copyDebugLog();
  assert.equal(copied, null);
  assert.match(globalThis.__notices.at(-1), /Turn on Debug log in settings first/);
});

test('On (from data.json): entries are written, Copy puts the log on the clipboard, Clear removes it', async () => {
  const { plugin, files } = pluginWith({ debugLog: true });
  await plugin.loadSettings();
  api.debug.debugLog(plugin.app, 'TEST', { a: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(files.get(LOG), /--- TEST \[/);
  await plugin.copyDebugLog();
  assert.equal(copied, files.get(LOG));
  assert.match(globalThis.__notices.at(-1), /Debug log copied/);

  await api.debug.clearDebugLog(plugin.app);
  assert.equal(files.has(LOG), false);

  // Turning it off in settings stops the writing.
  plugin.settings.debugLog = false;
  await plugin.saveSettings();
  api.debug.debugLog(plugin.app, 'TEST', { a: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(files.has(LOG), false);
});
