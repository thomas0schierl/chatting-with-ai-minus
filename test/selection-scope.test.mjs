// A turn sent with a selection may change only the selected text of that
// note: the tools enforce it, the instruction in the message isn't enough.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, transport, response, text, call, chatSetup } from './harness.mjs';

const NOTE = '## Feedback\n- crowded plan\n- low contrast\n\n## Decisions\n- crowded plan stays grouped\n';
const SELECTED = '- crowded plan\n- low contrast';

function vault(notes) {
  const files = new Map(Object.entries(notes));
  const app = {
    workspace: { getActiveFile: () => ({ path: 'Review.md' }) },
    vault: {
      getFileByPath: path => files.has(path) ? { path } : null,
      getAbstractFileByPath: path => files.has(path) ? { path } : null,
      process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
      modify: async (file, content) => { files.set(file.path, content); },
    },
    fileManager: {
      processFrontMatter: async () => { files.set('touched', 'yes'); },
      renameFile: async () => { files.set('touched', 'yes'); },
      trashFile: async () => { files.set('touched', 'yes'); },
    },
  };
  return { app, files };
}

const run = (app, name, input, scope) => api.executeTool(app, name, input, async () => 'yes', scope);

test('find_replace changes the text inside the selection, not an earlier match elsewhere', async () => {
  const { app, files } = vault({ 'Review.md': `Intro: - crowded plan\n\n${NOTE}` });
  const scope = { filePath: 'Review.md', text: SELECTED };
  const result = await run(app, 'edit_document', { path: 'Review.md', operation: 'find_replace', find: '- crowded plan', content: '- [ ] Group the plan by bed' }, scope);
  assert.equal(result.isError, false);
  assert.equal(files.get('Review.md'), 'Intro: - crowded plan\n\n## Feedback\n- [ ] Group the plan by bed\n- low contrast\n\n## Decisions\n- crowded plan stays grouped\n');
  // The scope follows the edit: the next edit in the turn finds the new text.
  assert.equal(scope.text, '- [ ] Group the plan by bed\n- low contrast');
  const second = await run(app, 'edit_document', { operation: 'find_replace', find: '- [ ] Group the plan by bed', content: '- [ ] Group by bed' }, scope);
  assert.equal(second.isError, false);
  assert.match(files.get('Review.md'), /## Feedback\n- \[ \] Group by bed\n- low contrast/);
});

test('Text outside the selection, a whole-note replace or an insert is refused; the note stays as it was', async () => {
  for (const input of [
    { operation: 'find_replace', find: '- crowded plan stays grouped', content: 'gone' },
    { operation: 'find_replace', find: '## Decisions', content: '## Done' },
    { operation: 'replace_all', content: 'everything new' },
    { operation: 'insert', position: 'end', content: 'more' },
  ]) {
    const { app, files } = vault({ 'Review.md': NOTE });
    const result = await run(app, 'edit_document', { path: 'Review.md', ...input }, { filePath: 'Review.md', text: SELECTED });
    assert.equal(result.isError, true, input.operation);
    assert.match(result.result, /^Not changed:/);
    assert.equal(files.get('Review.md'), NOTE, input.operation);
  }
});

test('The selected note can\'t be renamed, deleted or get new properties; other notes stay editable', async () => {
  const scope = { filePath: 'Review.md', text: SELECTED };
  for (const [name, input] of [
    ['rename_file', { path: 'Review.md', new_path: 'Old.md' }],
    ['delete_file', { path: 'Review.md' }],
    ['set_properties', { path: 'Review.md', properties: { status: 'done' } }],
    ['set_properties', { properties: { status: 'done' } }],
  ]) {
    const { app, files } = vault({ 'Review.md': NOTE });
    const result = await run(app, name, input, scope);
    assert.equal(result.isError, true, name);
    assert.match(result.result, /only that selection may change/);
    assert.equal(files.has('touched'), false, name);
  }
  const { app, files } = vault({ 'Review.md': NOTE, 'Tasks.md': 'Old' });
  const other = await run(app, 'edit_document', { path: 'Tasks.md', operation: 'replace_all', content: 'New' }, scope);
  assert.equal(other.isError, false);
  assert.equal(files.get('Tasks.md'), 'New');
});

test('A selected text that also appears earlier: the selected copy changes (by its offset), the earlier stays', async () => {
  const note = '## Monday\n- [ ] call Bob\n\n## Friday\n- [ ] call Bob\n';
  const from = note.lastIndexOf('- [ ] call Bob');
  const { app, files } = vault({ 'Review.md': note });
  const scope = { filePath: 'Review.md', text: '- [ ] call Bob', from };
  await run(app, 'edit_document', { path: 'Review.md', operation: 'find_replace', find: 'call Bob', content: 'call Bob about the quote' }, scope);
  assert.equal(files.get('Review.md'), '## Monday\n- [ ] call Bob\n\n## Friday\n- [ ] call Bob about the quote\n');
  // A second edit stays on the same copy.
  await run(app, 'edit_document', { path: 'Review.md', operation: 'find_replace', find: '- [ ]', content: '- [x]' }, scope);
  assert.equal(files.get('Review.md'), '## Monday\n- [ ] call Bob\n\n## Friday\n- [x] call Bob about the quote\n');
});

test('A folder the selected note is in can\'t be renamed or deleted', async () => {
  const scope = { filePath: 'Projects/Plan.md', text: 'x' };
  for (const [name, input] of [
    ['delete_file', { path: 'Projects' }],
    ['rename_file', { path: 'Projects/', new_path: 'Archive' }],
    ['delete_file', { path: '/' }],
  ]) {
    const { app, files } = vault({ 'Projects/Plan.md': 'x', 'Projects': '' });
    const result = await run(app, name, input, scope);
    assert.match(result.result, /only that selection may change/, `${name} ${input.path}`);
    assert.equal(files.has('touched'), false);
  }
  // A folder with a similar name is not the note's folder.
  const { app } = vault({ 'Projects/Plan.md': 'x', 'Projects-old': '' });
  const result = await run(app, 'delete_file', { path: 'Projects-old' }, scope);
  assert.equal(result.isError, false);
});

test('A selection no longer in the note as selected (changed meanwhile) can\'t be edited', async () => {
  const { app, files } = vault({ 'Review.md': NOTE.replace('low contrast', 'contrast fixed') });
  const before = files.get('Review.md');
  const result = await run(app, 'edit_document', { path: 'Review.md', operation: 'find_replace', find: '- crowded plan', content: 'x' }, { filePath: 'Review.md', text: SELECTED });
  assert.match(result.result, /no longer in Review\.md as it was selected/);
  assert.equal(files.get('Review.md'), before);
});

test('In a chat turn with a selection the model can\'t change the rest of the note; without one it can', async () => {
  const { view, files } = await chatSetup('anthropic');
  files.set('Review.md', NOTE);
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('e1', 'edit_document', { path: 'Review.md', operation: 'replace_all', content: 'all new' })], 'tool_use')
    : response('anthropic', [text('Done.')]));
  await view.handleUserMessage('Rewrite this as tasks', { filePath: 'Review.md', text: SELECTED });
  assert.equal(files.get('Review.md'), NOTE);
  assert.match(JSON.stringify(requests[1]), /Not changed: the user selected text in Review\.md/);

  // The next turn has no selection: nothing is held back.
  transport((body, index) => index === 0
    ? response('anthropic', [call('e2', 'edit_document', { path: 'Review.md', operation: 'replace_all', content: 'all new' })], 'tool_use')
    : response('anthropic', [text('Done.')]));
  await view.handleUserMessage('Now rewrite the whole note', null);
  assert.equal(files.get('Review.md'), 'all new');
});
