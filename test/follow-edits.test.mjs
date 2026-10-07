// Following the AI's edits: the editing tools report what changed, the
// chat shows it in the main area (one reused tab, Obsidian's search-match
// state for scrolling and highlighting), and open_document shows a spot
// when the user asks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, transport, response, text, call, chatSetup } from './harness.mjs';

const { changedRange, visibleRange, showInView, viewportFor, closeFollowTab } = api.showInView;

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

test('Canvas: the view centers the cards and zooms out only when they don\'t fit, never in', () => {
  const box = { minX: 100, minY: 0, maxX: 300, maxY: 100 };
  // Fits at 100 % (zoom 0): centered, zoom kept.
  assert.deepEqual(viewportFor(box, 800, 600, 0), { x: 200, y: 50, zoom: 0 });
  // Already zoomed out further: stays (no zooming in).
  assert.deepEqual(viewportFor(box, 800, 600, -2), { x: 200, y: 50, zoom: -2 });
  // Too wide for 400 px at 100 %: zooms out to fit with a 10 % margin.
  const wide = viewportFor({ minX: 0, minY: 0, maxX: 2000, maxY: 100 }, 400, 600, 0);
  assert.equal(wide.x, 1000);
  assert.ok(Math.abs(wide.zoom - Math.log2(400 / 2200)) < 1e-9);
});

test('Canvas: all changed cards are selected and centered (the canvas view API is checked first)', async () => {
  const files = new Map([['Map.canvas', '{}']]);
  const app = { vault: {}, workspace: {} };
  const { leaves } = workspace(app, files);
  const card = (minX, minY) => ({ getBBox: () => ({ minX, minY, maxX: minX + 200, maxY: minY + 100 }) });
  const cards = new Map([['a', card(0, 0)], ['b', card(400, 300)], ['c', card(900, 900)]]);
  const canvas = { nodes: cards, selection: new Set(), updateSelection(fn) { fn(); }, canvasRect: { width: 1200, height: 900 },
    tx: 0, ty: 0, tZoom: 0, zoomCenter: 'x', markViewportChanged() { canvas.changed = true; } };
  await showInView(app, { path: 'Map.canvas', nodes: ['a', 'b'] });
  // The tab got the canvas; give its view the canvas and show again.
  leaves[0].view.canvas = canvas;
  await showInView(app, { path: 'Map.canvas', nodes: ['a', 'b'] });
  assert.deepEqual([...canvas.selection], [cards.get('a'), cards.get('b')]);
  assert.deepEqual([canvas.tx, canvas.ty, canvas.tZoom, canvas.zoomCenter, canvas.changed], [300, 200, 0, null, true]);

  // Without the internal canvas API nothing breaks: the match state alone is used.
  leaves[0].view.canvas = { nodes: 'not a map' };
  assert.equal(await showInView(app, { path: 'Map.canvas', nodes: ['a'] }), true);
});

test('The follow tab closes with the plugin, and one left from the last session at the next start', async () => {
  const files = new Map([['A.md', 'alpha']]);
  const app = { vault: {}, workspace: {} };
  const { leaves } = workspace(app, files);
  const storage = new Map();
  app.saveLocalStorage = (key, value) => (value === null ? storage.delete(key) : storage.set(key, value));
  app.loadLocalStorage = (key) => storage.get(key) ?? null;
  app.workspace.getLeafById = (id) => leaves.find((leaf) => leaf.id === id) ?? null;
  const detached = [];
  const withIds = () => leaves.forEach((leaf, i) => { leaf.id ??= `leaf-${i}`; leaf.detach = () => { detached.push(leaf.id); leaves.splice(leaves.indexOf(leaf), 1); }; });

  // Closing Obsidian: the open follow tab goes.
  const origGetLeaf = app.workspace.getLeaf;
  app.workspace.getLeaf = () => { const leaf = origGetLeaf(); withIds(); return leaf; };
  await showInView(app, { path: 'A.md', from: 0, to: 5 });
  assert.equal(storage.get('chatting-minus-follow-tab'), 'leaf-0');
  closeFollowTab(app);
  assert.deepEqual(detached, ['leaf-0']);
  // The ID stays: the layout may have been saved with the tab.
  assert.equal(storage.get('chatting-minus-follow-tab'), 'leaf-0');

  // Next start: the tab came back with the layout, known only by its saved ID.
  const left = origGetLeaf();
  left.id = 'leaf-0';
  left.detach = () => { detached.push('restored'); leaves.splice(leaves.indexOf(left), 1); };
  api.showInView.closeLeftoverFollowTab(app);
  assert.deepEqual(detached, ['leaf-0', 'restored']);
  assert.equal(storage.size, 0);
  // Nothing saved: nothing closes.
  api.showInView.closeLeftoverFollowTab(app);
  assert.equal(detached.length, 2);
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
