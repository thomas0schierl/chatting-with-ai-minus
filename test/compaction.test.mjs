// Compaction (ADR-18): each provider's own on its side (the request
// parameter, the compaction it returns, what later requests send), the
// plugin's summary where the provider can't (refused, another provider's
// compaction, a request too long, Compact now), and the note in the chat.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, sse, streamEvents, text, transport, chatSetup, withCatalog, settings, callbacks, vaultApp, responsesData } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

/** A summary request, by its instruction. */
const isSummaryRequest = body => JSON.stringify(body).includes('Summarize the conversation below');
const firstUserText = body => {
  const first = (body.messages ?? body.input)[0];
  const content = first.content;
  return typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
};

/** An Anthropic answer that compacted first: its compaction block (streamed in one delta), then the text. */
function compactedAnthropicAnswer(summary, answer) {
  const events = streamEvents('anthropic', [text(answer)]);
  // Shift the text block to index 1, the compaction block goes first.
  for (const event of events) if (typeof event.index === 'number') event.index += 1;
  events.splice(1, 0,
    { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: summary } },
    { type: 'content_block_stop', index: 0 });
  return sse(events);
}

test('Anthropic: threshold compaction at 80 % of the window where the model list has it; the summary comes back; later requests start there', async () => {
  const loopSettings = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, compaction: true }]);
  const headers = [];
  const requests = transport((body, index, request) => {
    headers.push(request.headers['anthropic-beta']);
    return index === 1 ? compactedAnthropicAnswer('They planned a garden.', 'A2') : sse(streamEvents('anthropic', [text(`A${index + 1}`)]));
  });
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  let compacted = 0;
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks({ onCompacted: () => compacted++ }));
  await agent.run('Q3', callbacks());

  assert.deepEqual(requests[0].context_management, { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 160000 } }] });
  assert.equal(headers[0], 'compact-2026-01-12');
  assert.equal(compacted, 1);
  const marker = agent.exportMessages().find(m => m.compaction);
  assert.deepEqual(marker.compaction, { summary: 'They planned a garden.' });
  // Q1, A1 and Q2 are covered by the compaction block: the third request starts with it.
  assert.equal(requests[2].messages[0].role, 'assistant');
  assert.equal(requests[2].messages[0].content[0].type, 'compaction');
  assert.equal(requests[2].messages.length, 2);
});

test('Anthropic: no compaction parameter for a model without it (or an unknown window)', async () => {
  const loopSettings = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, compaction: false }]);
  const headers = [];
  const requests = transport((body, index, request) => {
    headers.push(request.headers['anthropic-beta']);
    return sse(streamEvents('anthropic', [text('ok')]));
  });
  await new api.AgentLoop(vaultApp().app, loopSettings).run('Q1', callbacks());
  assert.equal(requests[0].context_management, undefined);
  assert.equal(headers[0], undefined);
});

/** A Responses answer whose output starts with a compaction item. */
function compactedResponsesAnswer(provider, answer, index) {
  return sse(streamEvents(provider, [{ type: 'compaction', id: `cmp_${index}`, encrypted_content: 'opaque' }, text(answer)], 'end_turn', index));
}

test('OpenAI: server-side compaction at 80 % of the window; a full replay starts at the compaction item', async () => {
  const loopSettings = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'gpt-5.5', contextWindow: 400000, detailsCheckedAt: Date.now() }]);
  const requests = transport((body, index) => index === 1 ? compactedResponsesAnswer('openai', 'A2', index) : sse(streamEvents('openai', [text(`A${index + 1}`)], 'end_turn', index)));
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks());
  assert.deepEqual(requests[0].context_management, [{ type: 'compaction', compact_threshold: 320000 }]);
  assert.ok(agent.exportMessages().some(m => m.compaction));

  // After a restart (no chaining) the history is replayed from the compaction on.
  agent.importMessages(JSON.parse(JSON.stringify(agent.exportMessages())));
  await agent.run('Q3', callbacks());
  const input = requests[2].input;
  assert.equal(requests[2].previous_response_id, undefined);
  assert.deepEqual(input[0], { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' });
  assert.doesNotMatch(JSON.stringify(input), /Q1|A1/);
});

test('ChatGPT: a refused compaction parameter is dropped and the request sent again; the plugin then summarizes at the threshold', async () => {
  const loopSettings = await withCatalog('chatgpt-oauth', [{ value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 100000, autoCompactTokens: 80000 }]);
  const requests = transport((body, index) => {
    if (body.context_management) return { status: 400, json: { error: { message: "Unknown parameter: 'context_management'." } } };
    if (isSummaryRequest(body)) return sse(streamEvents('chatgpt-oauth', [text('Summary of Q1.')], 'end_turn', index));
    return sse(streamEvents('chatgpt-oauth', [text(`A${index}`)], 'end_turn', index));
  });
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  const cb = callbacks();
  await agent.run('Q1', cb);
  assert.deepEqual(cb.errors, []);
  assert.ok(requests[0].context_management);
  assert.equal(requests[1].context_management, undefined);

  // The last request filled 90k of 100k: the next turn summarizes first.
  let compacted = 0;
  await agent.run('Q2', callbacks({ onCompacted: () => compacted++ }), null, [], undefined, { contextTokens: 90000 });
  assert.equal(compacted, 1);
  assert.ok(isSummaryRequest(requests[2]));
  assert.match(firstUserText(requests[3]), /^\[Summary of the earlier part of this conversation[\s\S]*Summary of Q1\./);
  assert.doesNotMatch(JSON.stringify(requests[3].input), /"Q1"|A1/);
});

test('Switching provider after an encrypted compaction: the new provider writes a readable summary first, once', async () => {
  const openai = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'gpt-5.5', contextWindow: 400000, detailsCheckedAt: Date.now() }]);
  transport((body, index) => index === 1 ? compactedResponsesAnswer('openai', 'A2', index) : sse(streamEvents('openai', [text(`A${index + 1}`)], 'end_turn', index)));
  const app = vaultApp().app;
  const agent = new api.AgentLoop(app, openai);
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks());

  const switched = new api.AgentLoop(app, settings('anthropic'));
  switched.importMessages(agent.exportMessages());
  const requests = transport((body, index) => sse(streamEvents('anthropic', [text(isSummaryRequest(body) ? 'Readable summary of Q1.' : `B${index}`)])));
  await switched.run('Q3', callbacks());
  await switched.run('Q4', callbacks());
  assert.ok(isSummaryRequest(requests[0]));
  assert.match(JSON.stringify(requests[0]), /Q1/);
  assert.match(firstUserText(requests[1]), /Readable summary of Q1\./);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /"Q1/);
  // Written once, kept with the history.
  assert.equal(requests.filter(isSummaryRequest).length, 1);
});

test('A request too long for the model: what came before the turn is summarized and the request sent again', async () => {
  const requests = transport((body, index) => {
    if (isSummaryRequest(body)) return sse(streamEvents('anthropic', [text('Summary of Q1.')]));
    if (index === 2) return { status: 400, json: { error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } } };
    return sse(streamEvents('anthropic', [text(`A${index}`)]));
  });
  const agent = new api.AgentLoop(vaultApp().app, settings('anthropic'));
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks());
  const cb = callbacks({ onCompacted: () => { cb.compacted = true; } });
  await agent.run('Q3', cb);
  assert.deepEqual(cb.errors, []);
  assert.equal(cb.compacted, true);
  assert.ok(isSummaryRequest(requests[3]));
  assert.match(firstUserText(requests[4]), /Summary of Q1\./);
  assert.deepEqual(cb.texts, ['A4']);
});

test('Compact now: the chat becomes a summary, a note shows it, the next request starts from it', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  const requests = transport((body, index) => sse(streamEvents('anthropic', [text(isSummaryRequest(body) ? 'All about tiles.' : `A${index + 1}`)])));
  await view.handleUserMessage('Q1', null);
  await view.compactNow();
  assert.ok(isSummaryRequest(requests[1]));
  assert.equal(chat.shown.at(-1).errorKind, 'compacted');
  assert.equal(plugin.chatHistory.at(-1).errorKind, 'compacted');
  await view.handleUserMessage('Q2', null);
  assert.match(firstUserText(requests[2]), /All about tiles\./);
  assert.equal(requests[2].messages.length, 2);
});

test('Transcript for a summary: roles, tools and files in short, its end kept when too long', () => {
  const S = api.summary;
  const messages = [
    { role: 'user', content: 'Plan the garden' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read_document', input: { path: 'Garden.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(2000) }, { type: 'file', file: { fileName: 'Plan.pdf' } }] },
    { role: 'assistant', content: 'Done.' },
  ];
  const all = S.transcript(messages, 100000);
  assert.match(all, /^User: Plan the garden\n\nAssistant: \[tool call read_document: \{"path":"Garden.md"\}\]\n\nUser: \[tool result: x{1000}…\]\n\[file: Plan.pdf\]\n\nAssistant: Done\.$/);
  const short = S.transcript(messages, 20);
  assert.match(short, /^\(The beginning of the conversation is left out\.\)\n…/);
  assert.ok(short.endsWith('Assistant: Done.'));
  assert.equal(S.isContextOverflow(new api.ProviderError('x', 400, 'context_length_exceeded')), true);
  assert.equal(S.isContextOverflow(new Error('prompt is too long')), false);
});
