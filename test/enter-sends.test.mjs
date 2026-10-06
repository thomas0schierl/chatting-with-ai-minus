// The "Enter sends message" setting: on by default, kept in data.json, passed to the chat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, chatSetup } from './harness.mjs';

async function loaded(saved) {
  const plugin = new api.ChatPlugin();
  plugin.loadData = async () => ({ ...settings('openai'), ...saved });
  plugin.loadApiKey = () => '';
  await plugin.loadSettings();
  return plugin;
}

test('Enter sends by default; turned off it stays off after a restart', async () => {
  assert.equal((await loaded({})).settings.enterSends, true);
  assert.equal((await loaded({ enterSends: false })).settings.enterSends, false);
  assert.equal((await loaded({ enterSends: 'no' })).settings.enterSends, true);
});

test('The chat view passes the setting to the chat', async () => {
  const { plugin, view, chat } = await chatSetup('openai');
  plugin.settings.enterSends = false;
  view.updateEnterSends();
  assert.equal(chat.enterSends, false);
  plugin.settings.enterSends = true;
  view.updateEnterSends();
  assert.equal(chat.enterSends, true);
});
