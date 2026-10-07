// AGENTS.md (ADR-16): the vault root's file in the system prompt, a
// folder's file with the first tool result touching that folder, once per
// conversation (found again by the history).
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, transport, response, text, call, chatSetup } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
});

async function vaultWith(files) {
  const setup = await chatSetup('anthropic');
  for (const [path, content] of Object.entries(files)) setup.files.set(path, content);
  setup.app.vault.getFileByPath = path => setup.files.has(path) ? { path } : null;
  return setup;
}

const systemText = body => JSON.stringify(body.system);
const toolResults = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
const resultText = block => typeof block.content === 'string' ? block.content : block.content.map(c => c.text ?? '').join('');

test('The root AGENTS.md is in the system prompt; without it the prompt is the built-in one', async () => {
  const { view, files } = await vaultWith({ 'AGENTS.md': 'Write in British English.\nDates as YYYY-MM-DD.' });
  const requests = transport(() => response('anthropic', [text('ok')]));
  await view.handleUserMessage('Hi', null);
  assert.match(systemText(requests[0]), /This vault's instructions \(AGENTS\.md\)[\s\S]*Write in British English\.\\nDates as YYYY-MM-DD\./);

  files.delete('AGENTS.md');
  await view.handleUserMessage('Again', null);
  assert.doesNotMatch(systemText(requests[1]), /This vault's instructions/);
  assert.match(systemText(requests[1]), /You are Chatting with AI Minus/);
});

test('A folder\'s AGENTS.md comes with the first result touching it, outer folders first, once per conversation; again after a cut', async () => {
  const { view, plugin } = await vaultWith({
    'Work/AGENTS.md': 'Work notes: keep a Status line.',
    'Work/Sub/AGENTS.md': 'Sub notes: in German.',
    'Work/Sub/Plan.md': 'Plan',
    'Home/Garden.md': 'Garden',
  });
  const requests = transport((body, index) => {
    if (index === 0) return response('anthropic', [call('r1', 'read_document', { path: 'Work/Sub/Plan.md' }), call('r2', 'read_document', { path: 'Home/Garden.md' })], 'tool_use');
    if (index === 2) return response('anthropic', [call('r3', 'read_document', { path: 'Work/Sub/Plan.md' })], 'tool_use', index);
    return response('anthropic', [text(`A${index}`)], 'end_turn', index);
  });
  await view.handleUserMessage('Read the plan and the garden', null);
  const [plan, garden] = toolResults(requests[1]);
  const planText = resultText(plan);
  assert.match(planText, /^# Work\/Sub\/Plan\.md\n\nPlan\n\n\[Instructions for files in Work\/, from Work\/AGENTS\.md[\s\S]*keep a Status line[\s\S]*Instructions for files in Work\/Sub\/, from Work\/Sub\/AGENTS\.md[\s\S]*in German/);
  assert.doesNotMatch(resultText(garden), /Instructions for files/);

  // The next turn reads the same note: the instructions aren't repeated.
  await view.handleUserMessage('Read it again', null);
  const again = toolResults(requests[3]).at(-1);
  assert.equal(resultText(again).includes('Instructions for files'), false);

  // Editing the first message cuts the turn that had them: they come again.
  const first = plugin.chatHistory.find(e => e.type === 'user').turnId;
  transport((body, index) => index === 0
    ? response('anthropic', [call('r4', 'read_document', { path: 'Work/Sub/Plan.md' })], 'tool_use')
    : response('anthropic', [text('done')], 'end_turn', index));
  await view.editMessage(first, 'Read the plan');
  const history = plugin.agent.exportMessages();
  const results = history.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
  assert.equal(results.length, 1);
  assert.match(results[0].content, /from Work\/Sub\/AGENTS\.md/);
});

test('Tools on the active note (no path) count for its folder', () => {
  const app = { workspace: { getActiveFile: () => ({ path: 'Work/Plan.md' }) } };
  assert.deepEqual(api.instructions.toolPaths(app, 'read_document', {}), ['Work/Plan.md']);
  assert.deepEqual(api.instructions.toolPaths(app, 'search_vault', { query: 'x' }), []);
  assert.deepEqual(api.instructions.toolPaths(app, 'rename_file', { path: 'A/x.md', new_path: 'B/x.md' }), ['A/x.md', 'B/x.md']);
});
