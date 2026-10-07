// Following the AI's edits: the editing tools report what changed, the
// chat shows it in the main area (one reused tab, Obsidian's search-match
// state for scrolling and highlighting), and open_document shows a spot
// when the user asks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, transport, response, text, call, chatSetup } from './harness.mjs';

const { changedRange, visibleRange, showInView } = api.showInView;

/** A workspace with main-area tabs that records what they open. */
function workspace(app, files) {
  const leaves = [];
  const newLeaf = () => {
    const leaf = {
      view: { file: null }, states: [], opened: [],
      async openFile(file, state) { leaf.view = { file }; leaf.opened.push({ path: file.path, state }); },
      setEphemeralState(state) { leaf.states.push(state); },
    };
    leaves.push(leaf);
    return leaf;
  };
  app.vault.getFileByPath = (path) => files.has(path) ? { path, extension: path.split('.').pop() } : null;
  app.vault.cachedRead = async (file) => files.get(file.path);
  const revealed = [];
  app.workspace = {
    ...app.workspace,
    iterateRootLeaves: (fn) => leaves.forEach(fn),
    getLeaf: () => newLeaf(),
    revealLeaf: async (leaf) => { revealed.push(leaf); },
  };
  return { leaves, newLeaf, revealed };
}

test('changedRange: the changed middle in the new text; visibleRange: a deletion shows its line', () => {
  assert.deepEqual(changedRange('a b c', 'a XY c'), { from: 2, to: 4 });
  assert.deepEqual(changedRange('same', 'same'), null);
  assert.deepEqual(changedRange('abc', 'abcdef'), { from: 3, to: 6 });
  // A deletion is an empty range (here after the shared "one\nt").
  assert.deepEqual(changedRange('one\ntwo\nthree', 'one\nthree'), { from: 5, to: 5 });
  assert.deepEqual(visibleRange('one\nthree', 4, 4), [4, 9]);
  assert.deepEqual(visibleRange('one\nthree', 0, 3), [0, 3]);
});

test('The editing tools report the changed range or canvas cards; nothing on an error', async () => {
  const files = new Map([['Note.md', '# Plan\n- one\n- two\n']]);
  const app = { workspace: { getActiveFile: () => null }, vault: {
    getFileByPath: (path) => files.has(path) ? { path, extension: 'md' } : null,
    cachedRead: async (file) => files.get(file.path),
    process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
  } };
  const run = (input) => api.executeTool(app, 'edit_document', { path: 'Note.md', ...input }, async () => 'yes');
  const edited = await run({ operation: 'find_replace', find: '- two', content: '- two\n- three' });
  assert.deepEqual(edited.focus, { path: 'Note.md', from: 19, to: 27 });
  assert.equal(files.get('Note.md').slice(19, 27), '- three\n');
  const failed = await run({ operation: 'find_replace', find: 'missing', content: 'x' });
  assert.equal(failed.focus, undefined);

  const canvas = { nodes: [{ id: 'a1', type: 'text', text: 'Old', x: 0, y: 0, width: 200, height: 60 }, { id: 'b2', type: 'text', text: 'Keep', x: 0, y: 100, width: 200, height: 60 }], edges: [] };
  files.set('Map.canvas', JSON.stringify(canvas));
  app.vault.getFileByPath = (path) => files.has(path) ? { path, extension: path.split('.').pop() } : null;
  const result = await api.executeTool(app, 'edit_canvas', { path: 'Map.canvas', operations: [{ op: 'update_node', id: 'a1', text: 'New' }] }, async () => 'yes');
  assert.equal(result.isError, false, result.result);
  assert.deepEqual(result.focus, { path: 'Map.canvas', nodes: ['a1'] });
});

test('showInView: one reused tab with the search-match state; a note already open is shown where it is', async () => {
  const files = new Map([['A.md', 'alpha beta'], ['B.md', 'gamma'], ['C.canvas', '{}']]);
  const app = { vault: {}, workspace: {} };
  const { leaves, newLeaf, revealed } = workspace(app, files);

  await showInView(app, { path: 'A.md', from: 6, to: 10 });
  assert.equal(leaves.length, 1);
  assert.deepEqual(leaves[0].opened[0], { path: 'A.md', state: { active: false, eState: { match: { content: 'alpha beta', matches: [[6, 10]] } } } });
  assert.equal(revealed.length, 1);

  // Another note: the same follow tab.
  await showInView(app, { path: 'B.md', from: 0, to: 5 });
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].opened[1].path, 'B.md');

  // A note the user has open in their own tab: shown there, no new tab.
  const own = newLeaf();
  own.view = { file: { path: 'A.md' } };
  await showInView(app, { path: 'A.md', from: 0, to: 5 });
  assert.deepEqual(own.states, [{ match: { content: 'alpha beta', matches: [[0, 5]] } }]);
  assert.equal(leaves.length, 2);

  // A canvas card: Obsidian's canvas match selects it and pans to it.
  await showInView(app, { path: 'C.canvas', nodes: ['n1'] });
  assert.deepEqual(leaves[0].opened.at(-1).state.eState, { match: { nodeId: 'n1', content: '', matches: [] } });
  assert.equal(await showInView(app, { path: 'Missing.md' }), false);
});

test('The chat follows an edit when the setting is on, not when it is off; the saved card has no range', async () => {
  for (const followEdits of [true, false]) {
    const { view, plugin, app, files } = await chatSetup('anthropic');
    plugin.settings.followEdits = followEdits;
    const { leaves } = workspace(app, files);
    transport((body, index) => index === 0
      ? response('anthropic', [call('e1', 'edit_document', { path: 'Untitled.md', operation: 'find_replace', find: 'Original', content: 'Changed' })], 'tool_use')
      : response('anthropic', [text('Done.')]));
    await view.handleUserMessage('Change it', null);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(files.get('Untitled.md'), 'Changed');
    assert.equal(leaves.length, followEdits ? 1 : 0, `followEdits ${followEdits}`);
    if (followEdits) assert.deepEqual(leaves[0].opened[0].state.eState.match.matches, [[0, 7]]);
    const card = plugin.chatHistory.find((e) => e.type === 'tool-result');
    assert.equal('focus' in card.toolResult, false);
  }
});

test('open_document shows the text the user asked for (and brings it forward), or the top when not found', async () => {
  const files = new Map([['Trip.md', '# Lisbon\n## Packing\n- shoes']]);
  const app = { vault: {}, workspace: {} };
  const { leaves, revealed } = workspace(app, files);
  const run = (input) => api.executeTool(app, 'open_document', input, async () => 'yes');
  assert.equal((await run({ path: 'Trip.md', text: '## packing' })).result, 'Showed Trip.md at the text.');
  assert.deepEqual(leaves[0].opened[0].state.eState.match.matches, [[9, 19]]);
  assert.equal(revealed.length, 1);
  assert.match((await run({ path: 'Trip.md', text: 'nowhere' })).result, /wasn't found/);
});
