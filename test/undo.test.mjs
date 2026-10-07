// Undo per answer: the tools record their vault changes, undo takes them
// back (last first), files changed since are asked about, and the chat
// view shows the row, undoes it and tells the model with the next turn.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, transport, response, text, call, chatSetup } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  globalThis.__notices = [];
  globalThis.__modals = [];
});

/** A vault of text files and folders, with Obsidian's file classes. */
function fakeVault(initial) {
  const files = new Map(Object.entries(initial));
  const folders = new Set();
  const parents = path => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  for (const path of files.keys()) parents(path).forEach(folder => folders.add(folder));
  const fileAt = path => files.has(path) ? new api.TFile(path) : null;
  const folderAt = path => folders.has(path)
    ? new api.TFolder(path, [...files.keys(), ...folders].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')).map(p => fileAt(p) ?? folderAt(p)))
    : null;
  const vault = {
    getName: () => 'Test',
    getMarkdownFiles: () => [...files.keys()].map(fileAt),
    getFileByPath: fileAt,
    getFolderByPath: folderAt,
    getAbstractFileByPath: path => fileAt(path) ?? folderAt(path),
    cachedRead: async file => files.get(file.path),
    read: async file => files.get(file.path),
    readBinary: async file => new TextEncoder().encode(files.get(file.path)).buffer,
    process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
    modify: async (file, content) => { files.set(file.path, content); },
    create: async (path, content) => { assert.ok(!files.has(path), path); files.set(path, content); return fileAt(path); },
    createBinary: async (path, data) => { assert.ok(!files.has(path), path); files.set(path, new TextDecoder().decode(data)); return fileAt(path); },
    createFolder: async path => { folders.add(path); },
  };
  const move = (from, to) => {
    for (const [path, content] of [...files]) {
      if (path === from || path.startsWith(`${from}/`)) { files.delete(path); files.set(to + path.slice(from.length), content); }
    }
    for (const folder of [...folders]) {
      if (folder === from || folder.startsWith(`${from}/`)) { folders.delete(folder); folders.add(to + folder.slice(from.length)); }
    }
  };
  const trashed = [];
  const fileManager = {
    renameFile: async (item, to) => move(item.path, to),
    trashFile: async item => {
      trashed.push(item.path);
      for (const path of [...files.keys()]) if (path === item.path || path.startsWith(`${item.path}/`)) files.delete(path);
      for (const folder of [...folders]) if (folder === item.path || folder.startsWith(`${item.path}/`)) folders.delete(folder);
    },
  };
  const app = { vault, fileManager, workspace: { getActiveFile: () => null, getLeavesOfType: () => [] } };
  return { app, files, folders, trashed };
}

const run = (app, changes, name, input) => api.executeTool(app, name, input, async () => 'yes', undefined, changes);

test('Undo takes an answer\'s edits, new files, renames and deletes back, last first', async () => {
  const { app, files, folders } = fakeVault({
    'Plan.md': 'Old plan',
    'Notes/A.md': 'Note A',
    'Old/One.md': 'One',
    'Old/Deep/Two.md': 'Two',
  });
  const changes = new api.ChangeLog();
  for (const [name, input] of [
    ['edit_document', { path: 'Plan.md', operation: 'find_replace', find: 'Old', content: 'New' }],
    ['create_file', { path: 'Fresh/Idea.md', content: 'Idea' }],
    ['rename_file', { path: 'Notes/A.md', new_path: 'Archive/A.md' }],
    ['edit_document', { path: 'Archive/A.md', operation: 'insert', position: 'end', content: 'more' }],
    ['delete_file', { path: 'Old' }],
  ]) {
    const result = await run(app, changes, name, input);
    assert.equal(result.isError, false, `${name}: ${result.result}`);
  }
  // Failed and unchanged steps record nothing.
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'find_replace', find: 'missing', content: 'x' });
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'find_replace', find: 'New', content: 'New' });

  assert.deepEqual(changes.files(), ['Plan.md', 'Fresh/Idea.md', 'Archive/A.md', 'Old/One.md', 'Old/Deep/Two.md']);
  assert.deepEqual(await changes.conflicts(app), []);

  assert.deepEqual(await changes.undo(app), []);
  assert.deepEqual(Object.fromEntries([...files].sort()), {
    'Notes/A.md': 'Note A',
    'Old/Deep/Two.md': 'Two',
    'Old/One.md': 'One',
    'Plan.md': 'Old plan',
  });
  assert.ok(folders.has('Old/Deep'));
});

test('Files changed after the answer are named before undoing', async () => {
  const { app, files } = fakeVault({ 'Plan.md': 'Plan', 'Other.md': 'Other' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'AI plan' });
  await run(app, changes, 'edit_document', { path: 'Other.md', operation: 'replace_all', content: 'AI other' });
  await run(app, changes, 'create_file', { path: 'New.md', content: 'New' });
  await run(app, changes, 'rename_file', { path: 'New.md', new_path: 'Moved.md' });

  files.set('Plan.md', 'AI plan, then the user');
  files.delete('Moved.md');
  assert.deepEqual((await changes.conflicts(app)).sort(), ['Moved.md', 'Plan.md']);
});

/** A model that edits Plan.md in the first turn and answers plainly after. */
function editingModel() {
  return transport((body, index) => {
    if (index === 0) return response('anthropic', [call('e1', 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'AI plan' })], 'tool_use');
    return response('anthropic', [text(`A${index}`)], 'end_turn', index);
  });
}

async function chatWithPlan() {
  const setup = await chatSetup('anthropic');
  const vault = fakeVault({ 'Plan.md': 'My plan' });
  Object.assign(setup.app.vault, vault.app.vault);
  setup.app.fileManager = vault.app.fileManager;
  return { ...setup, files: vault.files };
}

test('An answer that changed files ends in a row with Undo; undo restores them and tells the model next turn', async () => {
  const { plugin, view, chat, files } = await chatWithPlan();
  const requests = editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  assert.equal(files.get('Plan.md'), 'AI plan');

  const row = plugin.chatHistory.at(-1);
  assert.equal(row.type, 'changes');
  assert.deepEqual(row.files, ['Plan.md']);
  assert.equal(row.turnId, plugin.chatHistory[0].turnId);
  assert.deepEqual(chat.shown.at(-1), { id: chat.shown.at(-1).id, type: 'changes', turnId: row.turnId, files: ['Plan.md'], changesState: 'undoable' });

  await view.undoChanges(row.turnId);
  assert.equal(files.get('Plan.md'), 'My plan');
  assert.equal(row.undone, true);
  assert.equal(chat.shown.at(-1).changesState, 'undone');
  // Undone once only.
  files.set('Plan.md', 'The user wrote this');
  await view.undoChanges(row.turnId);
  assert.equal(files.get('Plan.md'), 'The user wrote this');

  await view.handleUserMessage('What now?', null);
  const sent = requests.at(-1).messages.at(-1).content;
  assert.match(typeof sent === 'string' ? sent : JSON.stringify(sent), /The user undid the changes of one of your earlier answers in this chat: Plan\.md/);
  // Only with that turn.
  await view.handleUserMessage('And now?', null);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages.at(-1).content), /undid/);
  // A turn without changes gets no row.
  assert.equal(plugin.chatHistory.filter(e => e.type === 'changes').length, 1);
});

test('Undo after a later change asks first; Cancel keeps everything', async () => {
  const { plugin, view, files } = await chatWithPlan();
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const { turnId } = plugin.chatHistory.at(-1);
  files.set('Plan.md', 'AI plan, edited by the user');

  const cancelled = view.undoChanges(turnId);
  await new Promise(resolve => setTimeout(resolve, 0));
  const modal = globalThis.__modals.at(-1);
  assert.ok(modal instanceof api.UndoConfirmModal);
  assert.deepEqual(modal.changed, ['Plan.md']);
  modal.contentEl = { empty() {} };
  modal.close = () => modal.onClose();
  modal.decide(false);
  await cancelled;
  assert.equal(files.get('Plan.md'), 'AI plan, edited by the user');
  assert.notEqual(plugin.chatHistory.at(-1).undone, true);

  const confirmed = view.undoChanges(turnId);
  await new Promise(resolve => setTimeout(resolve, 0));
  const again = globalThis.__modals.at(-1);
  again.contentEl = { empty() {} };
  again.close = () => again.onClose();
  again.decide(true);
  await confirmed;
  assert.equal(files.get('Plan.md'), 'My plan');
});

test('The row is saved; after a restart it shows without Undo (the snapshots were in memory)', async () => {
  const { view, writes } = await chatWithPlan();
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = writes.at(-1);

  const { view: restored, chat: reloaded } = await chatSetup('anthropic', saved);
  restored.renderHistory();
  const row = reloaded.shown.find(m => m.type === 'changes');
  assert.deepEqual(row.files, ['Plan.md']);
  assert.equal(row.changesState, 'kept');
});
