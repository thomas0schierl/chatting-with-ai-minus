// ChatGPT plan usage cues (OpenAI's UI guidelines for "Sign in with ChatGPT"):
// usage limits aren't retried and show their own message; the plan welcome
// is shown once.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, sse, transport, chatSetup } from './harness.mjs';

const LIMIT = 'subscription_sharing_usage_limit_exceeded';
const limitReached = () => ({ status: 429, json: { error: { code: LIMIT, message: 'Usage limit reached' } } });
const hi = [{ role: 'user', content: 'Hi' }];

beforeEach(() => {
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
  globalThis.__modals = [];
  globalThis.__notices = [];
});

test('A usage limit (429) is not retried', async () => {
  const requests = transport(limitReached);
  await assert.rejects(api.sendMessage(settings('chatgpt-oauth'), hi, [], 'S'), api.auth.ChatGPTUsageLimitError);
  assert.equal(requests.length, 1);
});

test('Usage that could not be checked is a plain error to try again', async () => {
  transport(() => sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'Unavailable' } } }]));
  await assert.rejects(api.sendMessage(settings('chatgpt-oauth'), hi, [], 'S'),
    e => !(e instanceof api.auth.ChatGPTUsageLimitError) && /Try again in a moment/.test(e.message));
});

test('The chat shows a usage limit as its own message, also after reload', async () => {
  const { plugin, view, chat } = await chatSetup('chatgpt-oauth');
  transport(limitReached);
  await view.handleUserMessage('Hello', null);
  const shown = chat.shown.at(-1);
  assert.equal(shown.type, 'error');
  assert.equal(shown.errorKind, 'usage-limit');
  assert.equal(plugin.chatHistory.at(-1).errorKind, 'usage-limit');

  view.renderHistory();
  assert.equal(chat.shown.at(-1).errorKind, 'usage-limit');
});

test('Other errors stay plain', async () => {
  const { view, chat } = await chatSetup('chatgpt-oauth');
  transport(() => ({ status: 401, json: { detail: 'Not accepted' } }));
  await view.handleUserMessage('Hello', null);
  assert.equal(chat.shown.at(-1).type, 'error');
  assert.equal(chat.shown.at(-1).errorKind, undefined);
});

test('The plan welcome is shown after the first sign-in only', async () => {
  let saves = 0;
  const plugin = { settings: { ...settings('chatgpt-oauth'), chatgptPlanWelcomeShown: false }, saveSettings: async () => { saves++; } };
  const tab = new api.ChatSettingTab({}, plugin);
  tab.update = () => {};

  await tab.afterSignIn();
  assert.equal(globalThis.__modals.length, 1);
  assert.equal(plugin.settings.chatgptPlanWelcomeShown, true);
  assert.equal(saves, 1);

  await tab.afterSignIn();
  assert.equal(globalThis.__modals.length, 1);
  assert.deepEqual(globalThis.__notices, ['ChatGPT connected. Chats now use your ChatGPT plan.']);
});

test('The plan welcome flag survives a restart', async () => {
  const plugin = new api.ChatPlugin();
  plugin.loadData = async () => ({ ...settings('chatgpt-oauth'), chatgptPlanWelcomeShown: true });
  plugin.loadApiKey = () => '';
  await plugin.loadSettings();
  assert.equal(plugin.settings.chatgptPlanWelcomeShown, true);
});
