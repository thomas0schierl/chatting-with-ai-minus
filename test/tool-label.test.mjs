// The one-line labels of tool cards: what the AI does or did, and with what.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const { toolLabel, fileLabel } = api.toolLabels;

test('Labels name the note (file name without .md) and change with the state', () => {
  const input = { path: 'Projects/Kitchen Renovation.md', operation: 'find_replace' };
  assert.equal(toolLabel('edit_document', input, 'running'), 'Editing Kitchen Renovation…');
  assert.equal(toolLabel('edit_document', input, 'done'), 'Edited Kitchen Renovation');
  assert.equal(toolLabel('edit_document', input, 'error'), 'Editing Kitchen Renovation failed');
  assert.equal(toolLabel('read_document', {}, 'done'), 'Read the current note');
  assert.equal(toolLabel('edit_canvas', { path: 'Ideas/App map.canvas' }), 'Edited App map.canvas');
});

test('Searches, lists, renames, trash and unknown tools read naturally', () => {
  assert.equal(toolLabel('search_vault', { query: 'tiles' }), 'Searched for "tiles"');
  assert.equal(toolLabel('list_files', {}), 'Listed the vault');
  assert.equal(toolLabel('list_files', { path: 'Meetings/' }, 'running'), 'Listing Meetings…');
  assert.equal(toolLabel('rename_file', { path: 'A.md', new_path: 'Archive/B.md' }), 'Renamed A to B');
  assert.equal(toolLabel('delete_file', { path: 'Old.md' }), 'Moved to the trash: Old');
  assert.equal(toolLabel('get_current_datetime', {}), 'Checked the date');
  assert.equal(toolLabel('some_new_tool', {}, 'running'), 'some new tool…');
  assert.equal(fileLabel('  '), 'the current note');
});
