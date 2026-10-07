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
  assert.equal(fresh.settings.model, 'claude-sonnet-4-6');
  // No model saved: the provider's default, so adapters never need one of their own.
  for (const [provider, model] of [['openai', 'gpt-6.1-sol'], ['chatgpt-oauth', 'gpt-5.5']]) {
    const plugin = new api.ChatPlugin();
    plugin.loadData = async () => ({ provider, model: '' });
    plugin.loadApiKey = () => '';
    await plugin.loadSettings();
    assert.equal(plugin.settings.model, model);
  }
});

// A note with frontmatter `properties`, edited through processFrontMatter.
function propertiesVault(properties = {}) {
  const frontmatter = { ...properties };
  let edits = 0;
  const app = {
    workspace: { getActiveFile: () => null },
    vault: { getFileByPath: path => (path === 'Note.md' ? { path } : null), cachedRead: async () => `---\n${JSON.stringify(frontmatter)}\n---\nBody` },
    fileManager: { processFrontMatter: async (file, fn) => { edits++; fn(frontmatter); } },
  };
  return { app, frontmatter, edits: () => edits };
}

test('Every tool offered to the model has a handler in the executor', async () => {
  const names = api.TOOL_DEFINITIONS.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 20); // the count in arc42 section 5
  // A fake vault without files: each tool fails its own way, never as unknown.
  const app = { workspace: { getActiveFile: () => null }, vault: { getFileByPath: () => null, getAbstractFileByPath: () => null } };
  for (const name of names) {
    const result = await api.executeTool(app, name, {}, async () => '');
    assert.doesNotMatch(result.result, /^Unknown tool/, name);
  }
  assert.match((await api.executeTool(app, 'not_a_tool', {}, async () => '')).result, /^Unknown tool: not_a_tool/);
});

test('set_properties sets and removes keys through processFrontMatter, on the path or the active note', async () => {
  const { app, frontmatter } = propertiesVault({ status: 'draft', old: 'x', keep: 1 });
  const result = await run(app, 'set_properties', { path: 'Note.md', properties: { status: 'done', tags: ['a', 'b'], old: null } });
  assert.equal(result.isError, false);
  assert.deepEqual(frontmatter, { status: 'done', tags: ['a', 'b'], keep: 1 });
  assert.equal(result.result, 'Updated properties in Note.md. Set: status, tags. Removed: old.');

  assert.match((await run(app, 'set_properties', { path: 'Missing.md', properties: { a: 1 } })).result, /File not found: Missing\.md/);
  assert.match((await run(app, 'set_properties', { properties: { a: 1 } })).result, /No active document open/);
  app.workspace.getActiveFile = () => ({ path: 'Note.md' });
  await run(app, 'set_properties', { properties: { status: 'active' } });
  assert.equal(frontmatter.status, 'active');
});

test('set_properties refuses a list or a missing object and leaves the note alone', async () => {
  for (const properties of [['tag'], 'tag: x', undefined, null]) {
    const { app, frontmatter, edits } = propertiesVault({ keep: 1 });
    const result = await run(app, 'set_properties', { path: 'Note.md', properties });
    assert.equal(result.isError, true, JSON.stringify(properties));
    assert.match(result.result, /must be an object/);
    assert.equal(edits(), 0);
    assert.deepEqual(frontmatter, { keep: 1 });
  }
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
