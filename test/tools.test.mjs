// Vault tools through the real executor: the date for daily notes. Also
// how a selection scope reaches the model, and how saved settings load.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, text, response, transport, vaultApp, callbacks } from './harness.mjs';

test('Loaded settings: the iteration limit is kept within 1 to 100, the catalog is always there, no API key from data.json', async () => {
  for (const [saved, expected] of [[0, 1], [-5, 1], [7.4, 7], [250, 100], [Infinity, 20], ['30', 20]]) {
    const plugin = new api.ChatPlugin();
    plugin.loadData = async () => ({ maxIterations: saved, apiKey: 'leaked-key' });
    plugin.loadApiKey = () => '';
    await plugin.loadSettings();
    assert.equal(plugin.settings.maxIterations, expected, String(saved));
    assert.equal(plugin.settings.apiKey, '');
    assert.deepEqual(plugin.settings.modelCatalog, { entries: [] });
  }
  const fresh = new api.ChatPlugin();
  fresh.loadData = async () => null;
  fresh.loadApiKey = () => '';
  await fresh.loadSettings();
  assert.deepEqual(fresh.settings.modelCatalog, { entries: [] });
});

test('A multi-line selection is quoted line by line', async () => {
  const requests = transport(() => response('anthropic', [text('OK')]));
  const agent = new api.AgentLoop(vaultApp().app, settings('anthropic'));
  await agent.run('Shorten this', callbacks(), { text: 'First line\nSecond line\r\n\nFourth', filePath: 'Notes/Draft.md' });
  const sent = requests[0].messages[0].content;
  assert.match(sent, /Selected text:\n> First line\n> Second line\n> \n> Fourth\n\nShorten this$/);
});

const run = (app, name, input = {}) => api.executeTool(app, name, input, async () => 'yes');

test('get_current_datetime gives the local date, not the UTC one, near midnight', async () => {
  const RealDate = globalThis.Date;
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  // 23:30 on 5 October in Los Angeles is already 6 October in UTC.
  const instant = RealDate.parse('2026-10-06T06:30:00Z');
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  try {
    const result = await run({}, 'get_current_datetime');
    assert.equal(result.isError, false);
    assert.match(result.result, /\nDate: 2026-10-05$/);
    assert.match(result.result, /ISO: 2026-10-06T06:30:00\.000Z/);
  } finally {
    globalThis.Date = RealDate;
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});
