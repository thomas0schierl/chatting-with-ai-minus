import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import {
  bundled, api, settings, image, text, call, result, assistant, responseMessage, nativeCall, response, sse, transport, vaultApp, withCatalog, callbacks
} from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) api.clearCatalogModels(provider);
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

for (const provider of ['chatgpt-oauth', 'openai']) {
  test(`${provider}: legacy history encodes assistant text/output and preserves tool pairs`, () => {
    const input = api.buildResponsesInput([
      { role: 'user', content: [text('Copy template'), { type: 'image', image }] },
      { role: 'assistant', content: [text('Reading'), call('read', 'read_file', { path: 'Cases/Case Template.md' }), text('Then copy')] },
      { role: 'user', content: [result('read', 'template')] },
      { role: 'assistant', content: 'Done' },
    ], provider);
    assert.deepEqual(input.map(item => item.type), ['message', 'message', 'function_call', 'message', 'function_call_output', 'message']);
    assert.equal(input[0].content[0].type, 'input_text');
    assert.equal(input[0].content[1].type, 'input_image');
    assert.equal(input[1].content[0].type, 'output_text');
    assert.equal(input[3].content[0].type, 'output_text');
    assert.equal(input[5].content[0].type, 'output_text');
    assert.equal(input[2].call_id, input[4].call_id);
  });
  test(`${provider}: native reasoning/search/refusal survive persistence`, () => {
    const output = [{ type: 'reasoning', id: 'reasoning1', encrypted_content: 'fake-encrypted', summary: [] }, { type: 'web_search_call', id: 'search1', status: 'completed', action: { type: 'search', query: 'test' } }, { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot do that' }] }];
    const parsed = api.fromResponsesOutput({ output }, provider);
    assert.equal(parsed.content[0].text, 'Cannot do that');
    const saved = JSON.parse(JSON.stringify([assistant(parsed)]));
    assert.deepEqual(api.buildResponsesInput(saved, provider), output);
    const other = provider === 'openai' ? 'chatgpt-oauth' : 'openai';
    assert.equal(api.buildResponsesInput(saved, other)[0].content[0].type, 'output_text');
  });
  test(`${provider}: malformed complete tool arguments recover without vault writes`, async () => {
    for (const argumentsValue of ['{', 'null', '[]', '"string"', '']) {
      const { app, files } = vaultApp();
      const requests = transport((body, index) => {
        if (!index) return response(provider, [{ ...nativeCall('bad', 'edit_document', {}), arguments: argumentsValue }], 'tool_use', index);
        if (index === 2) return response(provider, [text('Done')], 'end_turn', index);
        assert.equal(files.get('Untitled.md'), 'Original');
        assert.match(body.input.at(-1).output, /Invalid tool arguments/);
        return response(provider, [text('Retrying'), call('retry', 'edit_document', { path: 'Untitled.md', operation: 'replace_all', content: 'Corrected' })], 'tool_use', index);
      });
      const cb = callbacks();
      await new api.AgentLoop(app, settings(provider)).run('Edit the note', cb);
      assert.deepEqual(cb.errors, []);
      assert.equal(requests.length, 3);
      assert.equal(files.get('Untitled.md'), 'Corrected');
    }
  });
}

for (const provider of ['chatgpt-oauth', 'openai', 'anthropic']) {
  for (const operation of ['create', 'edit']) {
    test(`${provider}: actual agent reads template then ${operation}s a note`, async () => {
      const { app, files } = vaultApp();
      const template = files.get('Cases/Case Template.md');
      const requests = transport((body, index) => {
        if (provider !== 'anthropic') {
          for (const item of body.input.filter(item => item.role === 'assistant')) {
            assert.ok(item.content.every(part => ['output_text', 'refusal'].includes(part.type)));
          }
        }
        if (index === 0) return response(provider, [text('Reading the template'), call('read', 'read_file', { path: 'Cases/Case Template.md' })], 'tool_use', index);
        const returned = provider === 'anthropic' ? body.messages.at(-1).content[0].content : body.input.at(-1).output;
        if (index === 1) {
          assert.equal(returned, template);
          return response(provider, [text('Writing the note'), operation === 'create' ? call('write', 'create_file', { path: 'Cases/Test Case.md', content: returned }) : call('write', 'edit_document', { path: 'Untitled.md', operation: 'replace_all', content: returned })], 'tool_use', index);
        }
        assert.match(returned, /Created|Replaced/);
        return response(provider, [text('Done')], 'end_turn', index);
      });
      const agent = new api.AgentLoop(app, settings(provider));
      const cb = callbacks();
      await agent.run(`Read the template then ${operation} the note`, cb);
      assert.deepEqual(cb.errors, []);
      assert.equal(requests.length, 3);
      assert.equal(files.get(operation === 'create' ? 'Cases/Test Case.md' : 'Untitled.md'), template);
      assert.equal(files.get('Cases/Case Template.md'), template);
      const saved = JSON.parse(JSON.stringify(agent.exportMessages()));
      agent.importMessages(saved);
      transport(body => {
        if (provider === 'anthropic') assert.deepEqual(body.messages[1].content, saved[1].replay.items);
        else {
          assert.equal(body.previous_response_id, undefined);
          assert.equal(body.input.filter(item => item.type === 'function_call').length, 2);
          assert.equal(body.input.filter(item => item.type === 'function_call_output').length, 2);
        }
        return response(provider, [text('Still here')]);
      });
      await agent.run('Continue after reloading', cb);
      assert.deepEqual(cb.errors, []);
    });
  }
  test(`${provider}: parallel results include tool errors with matching IDs`, async () => {
    const { app } = vaultApp();
    transport((body, index) => {
      if (!index) return response(provider, [call('good', 'read_file', { path: 'Cases/Case Template.md' }), call('bad', 'read_file', { path: 'missing.md' })], 'tool_use');
      const results = provider === 'anthropic' ? body.messages.at(-1).content : body.input.filter(item => item.type === 'function_call_output');
      assert.equal(results.length, 2);
      assert.deepEqual(results.map(item => item.tool_use_id ?? item.call_id), ['good', 'bad']);
      assert.match(results[1].content ?? results[1].output, /not found/i);
      if (provider === 'anthropic') assert.equal(results[1].is_error, true);
      return response(provider, [text('Reported failure')]);
    });
    const cb = callbacks();
    await new api.AgentLoop(app, settings(provider)).run('Read two files', cb);
    assert.deepEqual(cb.errors, []);
  });
  test(`${provider}: stopping parallel execution leaves complete call/result pairs`, async () => {
    const { app, files } = vaultApp();
    transport(() => response(provider, [call('read', 'read_file', { path: 'Cases/Case Template.md' }), call('write', 'create_file', { path: 'Never.md', content: 'Do not create' })], 'tool_use'));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks({ onToolResult() { agent.abort(); } });
    await agent.run('Two tools', cb);
    assert.equal(files.has('Never.md'), false);
    const results = agent.exportMessages().at(-1).content;
    assert.equal(results.length, 2);
    assert.equal(results[1].tool_use_id, 'write');
    assert.equal(results[1].is_error, true);
  });
  test(`${provider}: token limit does not execute a partial tool call`, async () => {
    const { app, files } = vaultApp();
    transport(() => response(provider, [call('write', 'create_file', { path: 'Never.md', content: 'partial' })], 'max_tokens'));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks();
    await agent.run('Too long', cb);
    assert.equal(files.has('Never.md'), false);
    assert.match(cb.errors[0], /token limit/);
    assert.equal(agent.exportMessages().length, 1);
  });
}

test('Anthropic: thinking/signatures/redacted thinking/search/citations replay unchanged', async () => {
  const raw = [
    { type: 'thinking', thinking: 'Internal test reasoning', signature: 'fake-signature' },
    { type: 'redacted_thinking', data: 'fake-redacted-data' },
    { type: 'server_tool_use', id: 'server1', name: 'web_search', input: { query: 'test' } },
    { type: 'web_search_tool_result', tool_use_id: 'server1', content: [{ type: 'web_search_result', title: 'Example', url: 'https://example.com', encrypted_content: 'fake-encrypted' }] },
    { type: 'text', text: 'Reading', citations: [{ type: 'web_search_result_location', url: 'https://example.com', cited_text: 'Example' }] },
    call('read', 'read_file', { path: 'Cases/Case Template.md' }),
  ];
  const messages = [{ role: 'user', content: [text('Read'), { type: 'image', image }] }];
  const requests = transport((body, index) => response('anthropic', index ? [text('Done')] : raw, index ? 'end_turn' : 'tool_use'));
  const first = await api.sendAnthropicMessage(settings('anthropic'), messages, [], 'System');
  assert.deepEqual(first.content.map(block => block.type), ['text', 'tool_use', 'text']);
  assert.equal(first.content[2].text, '\n\nSources:\n- [https://example.com](https://example.com)');
  messages.push(assistant(first), { role: 'user', content: [result('read', 'Contents', true)] });
  await api.sendAnthropicMessage(settings('anthropic'), JSON.parse(JSON.stringify(messages)), [], 'System');
  assert.deepEqual(requests[1].messages[1].content, raw);
  assert.equal(requests[1].messages[0].content[1].source.media_type, 'image/png');
  assert.equal(requests[1].messages[2].content[0].is_error, true);
  assert.equal(requests[1].system[0].cache_control.type, 'ephemeral');
  assert.equal(requests[1].tools.at(-1).cache_control.type, 'ephemeral');
});

test('Anthropic web search as documented: results stay encrypted for replay, cited pages follow the answer', async () => {
  // Stream shape from the web search tool docs (docs.claude.com, "Web search tool").
  const result = { type: 'web_search_result', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon - Wikipedia', encrypted_content: 'fake-encrypted', page_age: 'April 30, 2025' };
  const citation = { type: 'web_search_result_location', url: result.url, title: result.title, encrypted_index: 'fake-index', cited_text: 'Claude Elwood Shannon (April 30, 1916' };
  const failed = { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' };
  const start = (index, content_block) => ({ type: 'content_block_start', index, content_block });
  const delta = (index, value) => ({ type: 'content_block_delta', index, delta: value });
  const stop = index => ({ type: 'content_block_stop', index });
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
    start(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' }),
    delta(0, { type: 'input_json_delta', partial_json: '{"query":"claude shannon' }), delta(0, { type: 'input_json_delta', partial_json: ' birth date"}' }), stop(0),
    start(1, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [result] }), stop(1),
    start(2, { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search' }), stop(2),
    start(3, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: failed }), stop(3),
    start(4, { type: 'text', text: '' }), delta(4, { type: 'text_delta', text: 'Based on the search results, ' }), stop(4),
    start(5, { type: 'text', text: '' }), delta(5, { type: 'citations_delta', citation }), delta(5, { type: 'text_delta', text: 'Claude Shannon was born on April 30, 1916.' }), stop(5),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
  ];
  const requests = transport((body, index) => index ? response('anthropic', [text('Done')]) : sse(events));
  const messages = [{ role: 'user', content: 'When was Claude Shannon born?' }];
  const first = await api.sendAnthropicMessage(settings('anthropic'), messages, [], 'System');
  assert.equal(first.content.map(block => block.text).join(''),
    'Based on the search results, Claude Shannon was born on April 30, 1916.\n\nSources:\n- [Claude Shannon - Wikipedia](https://en.wikipedia.org/wiki/Claude_Shannon)');
  assert.deepEqual(first.replay.items, [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'claude shannon birth date' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [result] },
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: failed },
    { type: 'text', text: 'Based on the search results, ' },
    { type: 'text', text: 'Claude Shannon was born on April 30, 1916.', citations: [citation] },
  ]);
  // The next turn sends the blocks back exactly as received.
  messages.push(assistant(first), { role: 'user', content: 'And where?' });
  await api.sendAnthropicMessage(settings('anthropic'), JSON.parse(JSON.stringify(messages)), [], 'System');
  assert.deepEqual(requests[1].messages[1], { role: 'assistant', content: first.replay.items });
});

test('Anthropic: pause_turn continues server search within the same user turn', async () => {
  const { app } = vaultApp();
  const raw = [{ type: 'server_tool_use', id: 'search1', name: 'web_search', input: { query: 'test' } }];
  const requests = transport((body, index) => {
    if (!index) return response('anthropic', raw, 'pause_turn');
    assert.deepEqual(body.messages.at(-1), { role: 'assistant', content: raw });
    assert.deepEqual(body.tools, requests[0].tools);
    return response('anthropic', [text('Search completed')]);
  });
  const cb = callbacks();
  await new api.AgentLoop(app, settings('anthropic')).run('Search', cb);
  assert.equal(requests.length, 2);
  assert.deepEqual(cb.errors, []);
  assert.deepEqual(cb.texts, ['Search completed']);
});

const anthropicModels = [
  { value: 'claude-future-adaptive', label: 'Adaptive', thinkingType: 'adaptive', reasoningEfforts: ['low', 'high', 'max'] },
  { value: 'claude-future-budget', label: 'Budget', thinkingType: 'enabled' },
  { value: 'claude-future-plain', label: 'Plain' },
];
for (const [model, level, thinking, effort] of [
  ['claude-future-adaptive', '', { type: 'adaptive' }, undefined],
  ['claude-future-adaptive', 'max', { type: 'adaptive' }, 'max'],
  ['claude-future-adaptive', 'xhigh', { type: 'adaptive' }, undefined],
  ['claude-future-budget', 'high', { type: 'enabled', budget_tokens: 8192 }, undefined],
  ['claude-future-plain', 'high', undefined, undefined],
  ['claude-sonnet-4-6', 'high', undefined, undefined],
]) {
  test(`Anthropic: ${model} with level "${level}" takes thinking and effort from the catalog`, async () => {
    const requests = transport(() => response('anthropic', [text('Hello')]));
    const config = await withCatalog('anthropic', anthropicModels, { model, thinkingLevel: level, enableWebSearch: false });
    await api.sendAnthropicMessage(config, [{ role: 'user', content: 'Hello' }], [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }], 'System');
    assert.deepEqual(requests[0].thinking, thinking);
    assert.deepEqual(requests[0].output_config, effort && { effort });
    assert.equal(requests[0].max_tokens, 16384);
    if (thinking?.budget_tokens) assert.ok(thinking.budget_tokens < requests[0].max_tokens);
    assert.equal(requests[0].tools.at(-1).cache_control.type, 'ephemeral');
  });
}
test('Anthropic catalog: thinking type and effort levels come from /v1/models capabilities', async () => {
  const identity = await api.catalogIdentity('anthropic', 'capabilities');
  globalThis.__providerRequest = async () => ({ status: 200, json: { has_more: false, data: [
    { type: 'model', id: 'claude-a', capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } }, effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true }, max: { supported: true } } } },
    { type: 'model', id: 'claude-b', capabilities: { thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } }, effort: { supported: false, low: { supported: true } } } },
    { type: 'model', id: 'claude-c' },
  ] } });
  const state = { entries: [] };
  const models = await api.refreshCatalog(state, 'anthropic', identity, 'capabilities', {}, true);
  assert.equal(models[0].thinkingType, 'adaptive');
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'high', 'max']);
  assert.equal(models[1].thinkingType, 'enabled');
  assert.equal(models[1].reasoningEfforts, undefined);
  assert.equal(models[2].thinkingType, undefined);
  assert.equal(models[2].reasoningEfforts, undefined);
  const restored = api.normalizeCatalogState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.entries[0].models[0].thinkingType, 'adaptive');
  assert.deepEqual(restored.entries[0].models[0].reasoningEfforts, ['low', 'high', 'max']);
});

test('OpenAI: settings connection tests do not steal a conversation response ID', async () => {
  const history = [{ role: 'user', content: 'Hello' }];
  const requests = transport((body, index) => response('openai', [text('Hello')], 'end_turn', index));
  const first = await api.sendOpenAIMessage(settings('openai'), history, [], 'System');
  history.push(assistant(first), { role: 'user', content: 'Follow up' });
  await api.sendOpenAIMessage(settings('openai'), [{ role: 'user', content: 'Connection test' }], [], 'Test');
  await api.sendOpenAIMessage(settings('openai'), history, [], 'System');
  assert.equal(requests[1].previous_response_id, undefined);
  assert.equal(requests[2].previous_response_id, 'resp_0');
  assert.equal(requests[2].input.length, 1);
  assert.equal(requests[2].input[0].content[0].text, 'Follow up');
});

test('OpenAI: restored legacy history retains function call/output pairs', async () => {
  const history = [{ role: 'user', content: 'Read' }, { role: 'assistant', content: [text('Reading'), call('read', 'read_file', { path: 'x' })] }, { role: 'user', content: [result('read', 'value')] }];
  const requests = transport(() => response('openai', [text('Done')]));
  await api.sendOpenAIMessage(settings('openai'), history, [], 'System');
  assert.deepEqual(requests[0].input.map(item => item.type), ['message', 'message', 'function_call', 'function_call_output']);
});

test('ChatGPT: incomplete SSE is rejected instead of executing finished tool items', async () => {
  transport(() => sse([{ type: 'response.output_item.done', output_index: 0, item: nativeCall('write', 'create_file', { path: 'Never.md' }) }]));
  await assert.rejects(api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Create' }], [], 'System'), /ended before the answer was complete/);
});

test('History trimming retains complete user turns rather than orphan tool results', () => {
  const history = [];
  for (let turn = 0; turn < 6; turn++) {
    history.push({ role: 'user', content: `Turn ${turn}` });
    for (let step = 0; step < 4; step++) history.push({ role: 'assistant', content: [call(`${turn}_${step}`, 'read_file', {})] }, { role: 'user', content: [result(`${turn}_${step}`, 'value')] });
  }
  const trimmed = api.trimHistory(history, 40);
  assert.equal(trimmed[0].content, 'Turn 1');
  assert.equal(trimmed.length, 45);
  assert.equal(api.trimHistory(history.slice(2), 100)[0].content, 'Turn 1');
  const longTurn = history.slice(0, 9);
  assert.deepEqual(api.trimHistory(longTurn, 3), longTurn);
});

test('Anthropic: mixed server search and client read preserve raw content through agent loop', async () => {
  const { app } = vaultApp();
  const raw = [
    { type: 'thinking', thinking: '', signature: 'fake-signature' },
    { type: 'redacted_thinking', data: 'fake-encrypted' },
    { type: 'server_tool_use', id: 'search1', name: 'web_search', input: { query: 'test' } },
    text('I will read the file'), call('read', 'read_file', { path: 'Cases/Case Template.md' }),
  ];
  transport((body, index) => {
    if (!index) return response('anthropic', raw, 'tool_use');
    assert.deepEqual(body.messages[1].content, raw);
    assert.deepEqual(body.messages.at(-1).content.map(block => block.type), ['tool_result']);
    return response('anthropic', [{ type: 'web_search_tool_result', tool_use_id: 'search1', content: [] }, text('Done')]);
  });
  const cb = callbacks();
  await new api.AgentLoop(app, settings('anthropic')).run('Search and read', cb);
  assert.deepEqual(cb.errors, []);
  assert.deepEqual(cb.executed, ['read_file']);
  assert.deepEqual(cb.texts, ['I will read the file', 'Done']);
});

test('Anthropic: repeated pause_turn respects iteration limit', async () => {
  const { app } = vaultApp();
  const requests = transport(() => response('anthropic', [{ type: 'server_tool_use', id: 'search1', name: 'web_search', input: {} }], 'pause_turn'));
  const cb = callbacks();
  await new api.AgentLoop(app, { ...settings('anthropic'), maxIterations: 2 }).run('Search', cb);
  assert.equal(requests.length, 2);
  assert.match(cb.errors[0], /maximum iterations/);
});

test('OpenAI: changing model/key or clearing state rebuilds full history', async () => {
  const history = [{ role: 'user', content: 'Hello' }];
  const requests = transport((body, index) => response('openai', [text('Hello')], 'end_turn', index));
  let s = settings('openai');
  for (let step = 0; step < 4; step++) {
    if (step === 1) s = { ...s, model: 'gpt-4o' };
    if (step === 2) s = { ...s, apiKey: 'different-fake-key' };
    if (step === 3) api.clearOpenAIState();
    const received = await api.sendOpenAIMessage(s, history, [], 'System');
    history.push(assistant(received), { role: 'user', content: 'More' });
    assert.equal(requests[step].previous_response_id, undefined);
    assert.equal(requests[step].input.length, step * 2 + 1);
  }
});

for (const provider of ['chatgpt-oauth', 'openai', 'anthropic']) {
  test(`${provider}: clearing during an API request cannot restore old history`, async () => {
    const { app } = vaultApp();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    transport(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks();
    const running = agent.run('Waiting', cb);
    await ready;
    agent.abort();
    agent.clear();
    release(response(provider, [text('Late response')]));
    await running;
    assert.deepEqual(agent.exportMessages(), []);
    assert.deepEqual(cb.texts, []);
  });
  test(`${provider}: Stop during a vault read keeps history valid for a new turn`, async () => {
    const { app } = vaultApp();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    app.vault.cachedRead = () => { started(); return new Promise(resolve => { release = resolve; }); };
    transport((body, index) => response(provider, index ? [text('New turn complete')] : [call('read', 'read_file', { path: 'Cases/Case Template.md' })], index ? 'end_turn' : 'tool_use', index));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks();
    const running = agent.run('Read', cb);
    await ready;
    agent.abort();
    const pending = agent.exportMessages().at(-1).content;
    assert.equal(pending[0].tool_use_id, 'read');
    assert.equal(pending[0].is_error, true);
    await agent.run('New turn', cb);
    release('Late read result');
    await running;
    assert.equal(pending[0].is_error, true);
    assert.deepEqual(cb.texts, ['New turn complete']);
    assert.deepEqual(cb.errors, []);
  });
}

test('ChatGPT: response.failed SSE surfaces an error', async () => {
  transport(() => sse([{ type: 'response.failed', response: { error: { message: 'Synthetic service failure' } } }]));
  await assert.rejects(api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Hello' }], [], 'System'), /Synthetic service failure/);
});

test('ChatGPT: aggregated completed SSE output is retained without item.done events', async () => {
  transport(() => sse([{ type: 'response.completed', response: { id: 'r1', output: [responseMessage('Hello')] } }]));
  const parsed = await api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Hello' }], [], 'System');
  assert.equal(parsed.content[0].text, 'Hello');
});


test('Catalog persistence rejects credentials and invalid identities', () => {
  const state = api.normalizeCatalogState({entries:[{provider:'openai',identity:'secret-key',fetchedAt:1,models:[]}],accessToken:'secret'});
  assert.deepEqual(state, {entries:[]});
});
test('Catalog: OAuth hidden filtering, reasoning metadata, TTL, force refresh and dedupe', async () => {
  const state = {entries:[]};
  const identity = await api.catalogIdentity('chatgpt-oauth', 'catalog-account');
  const requests = [];
  globalThis.__providerRequest = async request => {
    requests.push(request);
    return {status:200,json:{models:[
      {slug:'gpt-6.1-sol',display_name:'GPT 6.1',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'ultra'}],default_reasoning_level:'ultra'},
      {slug:'hidden-review',visibility:'hide'},
    ]}};
  };
  const oauth = {getUsableCredential:async()=>({accessToken:'fake-token',accountId:'catalog-account'})};
  const [models, duplicate] = await Promise.all([api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth,true),api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth,true)]);
  assert.equal(models,duplicate);
  assert.deepEqual(models.map(m=>m.value),['gpt-6.1-sol']);
  assert.equal(api.oauthReasoning('gpt-6.1-sol','').effort,'ultra');
  assert.equal(requests.length,1);
  const count = requests.length;
  await api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth);
  assert.equal(requests.length,count);
  await api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth,true);
  assert.equal(requests.length,count+1);
  assert.ok(!JSON.stringify(state).includes('fake-token'));
  api.clearCatalogModels('chatgpt-oauth');
});
test('Catalog: expired cache failure retained, backoff, manual retry and account isolation', async () => {
  const identity = await api.catalogIdentity('openai','key-a');
  const other = await api.catalogIdentity('openai','key-b');
  const models = [{value:'gpt-6.1-sol',label:'GPT 6.1'}];
  const state = {entries:[{provider:'openai',identity,models,fetchedAt:Date.now()-api.CATALOG_TTL-1}]};
  let requests = 0;
  globalThis.__providerRequest = async()=>{requests++;return {status:429,json:{}};};
  await assert.rejects(api.refreshCatalog(state,'openai',identity,'key-a',{}));
  assert.equal(state.entries[0].models,models);
  assert.equal(await api.refreshCatalog(state,'openai',identity,'key-a',{}),models);
  assert.equal(requests,1);
  assert.equal(api.cachedCatalog(state,'openai',other),undefined);
  assert.equal(api.getCatalogModels('openai'),undefined);
  globalThis.__providerRequest = async()=>({status:200,json:{data:[{id:'gpt-6.1-sol'},{id:'o9'},{id:'gpt-audio'},{id:'embedding'}]}});
  const next = await api.refreshCatalog(state,'openai',other,'key-b',{},true);
  assert.deepEqual(next.map(m=>m.value),['gpt-6.1-sol','o9']);
  assert.equal(state.entries.length,1);
  assert.equal(state.entries[0].identity,other);
});
test('Anthropic catalog: pagination and aliases for future generations', async () => {
  const identity = await api.catalogIdentity('anthropic','pagination');
  const urls = [];
  globalThis.__providerRequest = async request => {
    urls.push(request.url);
    return {status:200,json:urls.length===1 ? {data:[{type:'model',id:'claude-opus-5-5',display_name:'Claude Opus 5.5'}],has_more:true,last_id:'claude-opus-5-5'} : {data:[{type:'model',id:'claude-sonnet-6-1'}],has_more:false}};
  };
  const models = await api.refreshCatalog({entries:[]},'anthropic',identity,'pagination',{},true);
  assert.equal(models.length,2);
  assert.ok(urls[1].includes('after_id=claude-opus-5-5'));
});
test('GPT 6.1: reasoning only from catalog data, encrypted reasoning with it, canonical web search', async () => {
  const models = [{value:'gpt-6.1-sol',label:'GPT 6.1',reasoningEfforts:['low','high'],defaultReasoningEffort:'low'}];
  for (const provider of ['openai','chatgpt-oauth']) {
    const requests = transport(()=>response(provider,[text('OK')]));
    await (provider==='openai'?api.sendOpenAIMessage:api.sendChatGPTOAuthMessage)(await withCatalog(provider,models,{model:'gpt-6.1-sol',thinkingLevel:'high'}),[{role:'user',content:'test'}],[],'test');
    // The OpenAI API reports no reasoning data, so it never gets reasoning parameters.
    assert.deepEqual(requests[0].reasoning, provider==='openai' ? undefined : {effort:'high',summary:'auto'});
    assert.deepEqual(requests[0].include, provider==='openai' ? undefined : ['reasoning.encrypted_content']);
    assert.equal(requests[0].tools[0].type,'web_search');
  }
});
for (const [level, models, reasoning] of [
  ['high', [{value:'gpt-5.5',label:'GPT-5.5',reasoningEfforts:['low','high'],defaultReasoningEffort:'low'}], {effort:'high',summary:'auto'}],
  ['ultra', [{value:'gpt-5.5',label:'GPT-5.5',reasoningEfforts:['low','high'],defaultReasoningEffort:'low'}], {effort:'low',summary:'auto'}],
  ['', [{value:'gpt-5.5',label:'GPT-5.5',reasoningEfforts:['low','high'],defaultReasoningEffort:'low',supportsReasoningSummary:false}], {effort:'low'}],
  ['high', [{value:'gpt-5.5',label:'GPT-5.5'}], undefined],
  ['high', [], undefined],
]) {
  test(`ChatGPT: level "${level}" with ${models[0]?.reasoningEfforts ? 'catalog levels' : 'no catalog data'} sends ${JSON.stringify(reasoning)}`, async () => {
    const requests = transport(()=>response('chatgpt-oauth',[text('OK')]));
    await api.sendChatGPTOAuthMessage(await withCatalog('chatgpt-oauth',models,{thinkingLevel:level}),[{role:'user',content:'test'}],[],'test');
    assert.deepEqual(requests[0].reasoning,reasoning);
    assert.deepEqual(requests[0].include,reasoning && ['reasoning.encrypted_content']);
  });
}
test('Settings Test: the lightest catalog level and no web search; the chat settings stay as they are', async () => {
  const models = [{value:'gpt-5.5',label:'GPT-5.5',reasoningEfforts:['low','medium','high'],defaultReasoningEffort:'medium'}];
  const s = await withCatalog('chatgpt-oauth',models,{thinkingLevel:'high',enableWebSearch:true});
  api.cachedCatalog(s.modelCatalog,'chatgpt-oauth',await api.catalogIdentity('chatgpt-oauth','fake-account'));
  const requests = transport(()=>response('chatgpt-oauth',[text('Hello')]));
  assert.equal(await api.connectionTest(s),'Hello');
  assert.deepEqual(requests[0].reasoning,{effort:'low',summary:'auto'});
  assert.ok(!(requests[0].tools ?? []).some(t=>t.type==='web_search'));
  assert.equal(s.thinkingLevel,'high');
  assert.equal(s.enableWebSearch,true);
});
test('Anthropic Opus 5.5: adaptive thinking and model changes strip old signatures while preserving tool pairs', async () => {
  const requests = transport(()=>response('anthropic',[{type:'thinking',thinking:'private',signature:'signed-old'},text('Reading'),call('read','read_file',{path:'template'})],'tool_use'));
  const first = await api.sendAnthropicMessage(await withCatalog('anthropic',[{value:'claude-opus-5-5',label:'Claude Opus 5.5',thinkingType:'adaptive'}],{model:'claude-opus-5-5'}),[{role:'user',content:'test'}],[],'test');
  await api.sendAnthropicMessage({...settings('anthropic'),model:'claude-sonnet-6-1'},[{role:'user',content:'test'},assistant(first),{role:'user',content:[result('read','contents')]}],[],'test');
  assert.deepEqual(requests[0].thinking,{type:'adaptive'});
  assert.ok(!JSON.stringify(requests[1]).includes('signed-old'));
  assert.equal(requests[1].messages[1].content[1].type,'tool_use');
  assert.equal(requests[1].messages[2].content[0].tool_use_id,'read');
});
test('Responses: model changes rebuild text and tool pairs without encrypted reasoning from the prior model', () => {
  const input = api.buildResponsesInput([{role:'assistant',content:[text('Reading'),call('a','read_file',{})],replay:{provider:'chatgpt-oauth',model:'gpt-5.5',items:[{type:'reasoning',encrypted_content:'old'}]}},{role:'user',content:[result('a','data')]}],'chatgpt-oauth','gpt-6.1-sol');
  assert.deepEqual(input.map(i=>i.type),['message','function_call','function_call_output']);
});

test('Which account: the API key, or the ChatGPT account (its token until the ID is known)', () => {
  const noCredential = () => assert.fail('only asked for ChatGPT');
  assert.equal(api.secretIdentity('openai', 'sk-key', noCredential), 'sk-key');
  assert.equal(api.secretIdentity('anthropic', '', noCredential), '');
  assert.equal(api.secretIdentity('chatgpt-oauth', 'ignored', () => ({ accountId: 'acct', accessToken: 'tok' })), 'acct');
  assert.equal(api.secretIdentity('chatgpt-oauth', 'ignored', () => ({ accessToken: 'tok' })), 'tok');
  assert.equal(api.secretIdentity('chatgpt-oauth', 'ignored', () => null), '');
});

test('One replay rule for all adapters: recorded model and account must match; unrecorded items replay', () => {
  const native = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Native', annotations: [] }] };
  const message = (provider, recorded) => ({ role: 'assistant', content: [text('Plain')], replay: { provider, items: [native], ...recorded } });
  const sentText = (recorded, model, identity) => api.buildResponsesInput([message('openai', recorded)], 'openai', model, identity)[0].content[0].text;
  assert.equal(sentText({}, 'gpt-5.5', 'me'), 'Native');
  assert.equal(sentText({ model: 'gpt-5.5', identity: 'me' }, 'gpt-5.5', 'me'), 'Native');
  assert.equal(sentText({ model: 'gpt-4o' }, 'gpt-5.5', 'me'), 'Plain');
  assert.equal(sentText({ identity: 'other' }, 'gpt-5.5', 'me'), 'Plain');
  // A request whose model isn't known replays nothing recorded for a model.
  assert.equal(sentText({ model: 'gpt-5.5' }, undefined, 'me'), 'Plain');
  assert.equal(api.canReplay(message('anthropic', { model: 'claude-x' }), 'anthropic', 'claude-x', 'me'), true);
  assert.equal(api.canReplay(message('anthropic', { model: 'claude-x' }), 'openai', 'claude-x', 'me'), false);
  assert.equal(api.canReplay({ ...message('anthropic', {}), role: 'user' }, 'anthropic', 'claude-x', 'me'), false);
});

test('Provider replay is isolated across credential changes even with the same model', async () => {
  for (const provider of ['anthropic','openai','chatgpt-oauth']) {
    let account = 'first-account';
    api.setChatGPTOAuthService({getUsableCredential:async()=>({accessToken:'fake',accountId:account})});
    const native = provider === 'anthropic' ? {type:'thinking',thinking:'private',signature:'old-account-signature'} : {type:'reasoning',encrypted_content:'old-account-signature'};
    const requests = transport(()=>response(provider,[native,text('Read'),call('r','read_file',{})],'tool_use'));
    const send = provider==='anthropic'?api.sendAnthropicMessage:provider==='openai'?api.sendOpenAIMessage:api.sendChatGPTOAuthMessage;
    const first = await send(settings(provider),[{role:'user',content:'test'}],[],'test');
    account = 'second-account';
    await send({...settings(provider),apiKey:'different-key'},[{role:'user',content:'test'},assistant(first),{role:'user',content:[result('r','content')]}],[],'test');
    assert.ok(!JSON.stringify(requests[1]).includes('old-account-signature'));
    assert.ok(JSON.stringify(requests[1]).includes('read_file'));
  }
});

test('Settings: fresh persisted catalog opens repeatedly without network or resetting selected custom model', async () => {
  const identity = await api.catalogIdentity('openai','settings-cache');
  const plugin = {settings:{...settings('openai'),apiKey:'settings-cache',model:'future-custom',modelCatalog:{entries:[{identity,provider:'openai',models:[{value:'gpt-6.1-sol',label:'GPT 6.1'}],fetchedAt:Date.now()}]}},saveSettings:async()=>assert.fail('No write needed for fresh cache')};
  const tab = new api.ChatSettingTab({},plugin);
  tab.update = ()=>{};
  globalThis.__providerRequest = async()=>assert.fail('Fresh cache must not request network');
  await tab.loadCatalog(false);
  await tab.loadCatalog(false);
  assert.equal(tab.catalogModels[0].value,'gpt-6.1-sol');
  assert.equal(plugin.settings.model,'future-custom');
});
test('Settings: stale cache renders before background request resolves and failures keep the selection', async () => {
  const identity = await api.catalogIdentity('openai','settings-stale');
  const models = [{value:'gpt-5.5',label:'GPT 5.5'}];
  const plugin = {settings:{...settings('openai'),apiKey:'settings-stale',model:'future-custom',modelCatalog:{entries:[{identity,provider:'openai',models,fetchedAt:0}]}},saveSettings:async()=>{}};
  const tab = new api.ChatSettingTab({},plugin);
  const displays=[];
  tab.update=()=>displays.push(tab.catalogModels);
  let finish, started;
  const waiting = new Promise(resolve=>started=resolve);
  globalThis.__providerRequest=async()=>{started();return new Promise(resolve=>finish=resolve);};
  const refreshing=tab.loadCatalog(false);
  await waiting;
  assert.equal(displays[0],models);
  finish({status:503,json:{}});
  await refreshing;
  assert.equal(tab.catalogModels,models);
  assert.equal(plugin.settings.model,'future-custom');
});
test('Settings: account change during refresh never displays the former account result', async () => {
  let account='account-a';
  const plugin={settings:{...settings('chatgpt-oauth'),modelCatalog:{entries:[]}},chatgptOAuth:{getCredential:()=>({accountId:account}),getUsableCredential:async()=>({accessToken:'fake',accountId:account})},saveSettings:async()=>{}};
  const tab=new api.ChatSettingTab({},plugin);
  tab.update=()=>{};
  let finish, started;
  const waiting=new Promise(resolve=>started=resolve);
  globalThis.__providerRequest=async()=>(started(),new Promise(resolve=>finish=resolve));
  const refreshing=tab.loadCatalog(true);
  await waiting;
  account='account-b';
  finish({status:200,json:{models:[{slug:'only-account-a',visibility:'list'}]}});
  await refreshing;
  assert.equal(tab.catalogModels,undefined);
  globalThis.__providerRequest=async()=>({status:200,json:{models:[{slug:'only-account-b',visibility:'list'}]}});
  await tab.loadCatalog(false);
  assert.equal(tab.catalogModels[0].value,'only-account-b');
});

test('Catalog identity is stable without WebCrypto and scoped to the provider', async () => {
  const {createHash}=await import('node:crypto');
  const identity=await api.catalogIdentity('openai','synthetic-key');
  assert.equal(identity,createHash('sha256').update('openai:synthetic-key').digest('hex'));
  assert.notEqual(identity,await api.catalogIdentity('anthropic','synthetic-key'));
});

test('OAuth honors model capability metadata for summary and parallel calls', async () => {
  const identity=await api.catalogIdentity('chatgpt-oauth','capability-account');
  const model='future-custom-model';
  const state={entries:[{provider:'chatgpt-oauth',identity,fetchedAt:Date.now(),models:[{value:model,label:model,reasoningEfforts:['high'],defaultReasoningEffort:'invalid',supportsReasoningSummary:false,supportsParallelTools:false}]}]};
  api.setChatGPTOAuthService({getUsableCredential:async()=>({accessToken:'fake',accountId:'capability-account'})});
  const requests=transport(()=>response('chatgpt-oauth',[text('OK')]));
  await api.sendChatGPTOAuthMessage({...settings('chatgpt-oauth'),model,modelCatalog:state},[{role:'user',content:'test'}],[],'test');
  // An unknown default is never sent, and there is no summary: nothing to send.
  assert.equal(requests[0].reasoning,undefined);
  assert.equal(requests[0].parallel_tool_calls,false);
  await api.sendChatGPTOAuthMessage({...settings('chatgpt-oauth'),model,modelCatalog:state,thinkingLevel:'high'},[{role:'user',content:'test'}],[],'test');
  assert.deepEqual(requests[1].reasoning,{effort:'high'});
});

for (const provider of ['anthropic','openai','chatgpt-oauth']) {
  test(`${provider}: stopped request errors cannot affect a newer turn`, async () => {
    const {app}=vaultApp(); const agent=new api.AgentLoop(app,settings(provider));
    let rejectRequest, started;
    const waiting=new Promise(resolve=>started=resolve);
    globalThis.__providerRequest=async()=>{started();return new Promise((resolve,reject)=>rejectRequest=reject);};
    const old=callbacks(); const run=agent.run('old',old); await waiting;
    agent.clear();
    transport(()=>response(provider,[text('new completed')]));
    const next=callbacks(); await agent.run('new',next);
    rejectRequest(new Error('late transport failure')); await run;
    assert.deepEqual(old.errors,[]); assert.deepEqual(next.errors,[]);
    assert.equal(agent.exportMessages().length,2);
  });
}
test('Agent freezes provider/model configuration for a multi-tool turn', async () => {
  const {app}=vaultApp(); const config=settings('anthropic'); const agent=new api.AgentLoop(app,config);
  const requests=transport((body,index)=>response('anthropic',index===0?[call('r','read_file',{path:'Untitled.md'})]:[text('done')],index===0?'tool_use':'end_turn'));
  await agent.run('read',callbacks({onToolCall(){config.model='claude-opus-5-5';config.provider='openai';config.apiKey='changed';}}));
  assert.equal(requests.length,2);
  assert.equal(requests[0].model,requests[1].model);
});

test('Declarative settings stay searchable without fetching during indexing', () => {
  const plugin={settings:settings('openai')}; const tab=new api.ChatSettingTab({},plugin);
  globalThis.__providerRequest=async()=>assert.fail('Indexing must not perform network I/O');
  const definitions=tab.getSettingDefinitions();
  assert.deepEqual(definitions.map(d=>d.name ?? d.heading),['Provider','API key','ChatGPT account','Model','Custom model ID','Thinking level','Web search','Enter sends message',"Follow the AI's edits",'Vault instructions','Max tool iterations','Voice','MCP servers',undefined,'Debug log']);
  assert.equal(definitions[1].visible(),true); assert.equal(definitions[2].visible(),false);
  plugin.settings.provider='chatgpt-oauth'; assert.equal(definitions[1].visible(),false); assert.equal(definitions[2].visible(),true);
});
test('OAuth catalog refuses to associate a new account credential with an old cache identity', async () => {
  const state={entries:[]};
  const identity=await api.catalogIdentity('chatgpt-oauth','previous-account');
  globalThis.__providerRequest=async()=>assert.fail('Wrong account must not make a catalog request');
  await assert.rejects(api.refreshCatalog(state,'chatgpt-oauth',identity,'',{getUsableCredential:async()=>({accessToken:'fake',accountId:'new-account'})},true),/account changed/);
  assert.deepEqual(state.entries,[]);
});
test('Stopping during rate-limit backoff prevents the retried network request', async () => {
  let stopped=false,requests=0;
  const previousWindow=globalThis.window;
  globalThis.window={setTimeout(fn){stopped=true;queueMicrotask(fn);}};
  globalThis.__providerRequest=async()=>{requests++;return {status:429,json:{error:{message:'Rate limit reached'}}};};
  try {
    await assert.rejects(api.sendMessage(settings('openai'),[{role:'user',content:'test'}],[],'test',()=>stopped),/cancelled/);
    assert.equal(requests,1);
  } finally { globalThis.window=previousWindow; }
});

// Records what a settings row renders, in place of Obsidian's Setting.
function fakeSetting() {
  const row = { name: '', desc: undefined, options: [], value: undefined, onChange: undefined };
  const dropdown = { addOption(value, label) { row.options.push([value, label]); return dropdown; }, setValue(value) { row.value = value; return dropdown; }, onChange(fn) { row.onChange = fn; return dropdown; } };
  return { row, setting: { setName(name) { row.name = name; return this; }, setDesc(desc) { row.desc = desc; return this; }, addDropdown(fn) { fn(dropdown); return this; } } };
}
test('Settings: thinking level offers the catalog levels of the selected model and hides without them', async () => {
  const models = [
    {value:'gpt-5.5',label:'GPT-5.5',reasoningEfforts:['low','medium','xhigh'],defaultReasoningEffort:'medium'},
    {value:'claude-x',label:'Claude X',reasoningEfforts:['high','max']},
    {value:'gpt-4o',label:'GPT-4o'},
  ];
  const saved = [];
  const plugin = {settings:{...settings('chatgpt-oauth'),thinkingLevel:'xhigh'},saveSettings:async()=>saved.push(plugin.settings.thinkingLevel)};
  const tab = new api.ChatSettingTab({},plugin);
  tab.update = ()=>{};
  const thinking = tab.getSettingDefinitions().find(d=>d.name==='Thinking level');
  assert.equal(thinking.visible(), false);
  tab.catalogModels = models;
  assert.equal(thinking.visible(), true);
  let {row, setting} = fakeSetting();
  thinking.render(setting);
  assert.equal(row.name, 'Thinking level');
  assert.equal(row.desc, undefined);
  assert.deepEqual(row.options, [['','Default (medium)'],['low','low'],['medium','medium'],['xhigh','xhigh']]);
  assert.equal(row.value, 'xhigh');
  await row.onChange('low');
  assert.deepEqual(saved, ['low']);
  // A saved level the model doesn't offer stays saved and is marked.
  plugin.settings.model = 'claude-x';
  ({row, setting} = fakeSetting());
  thinking.render(setting);
  assert.deepEqual(row.options, [['','Default'],['high','high'],['max','max'],['low','low (not available)']]);
  assert.equal(row.value, 'low');
  assert.equal(plugin.settings.thinkingLevel, 'low');
  plugin.settings.model = 'gpt-4o';
  assert.equal(thinking.visible(), false);
  plugin.settings.model = 'custom-id';
  assert.equal(thinking.visible(), false);
});
test('Chat header shows the effective thinking level next to the model name', async () => {
  const models = [
    {value:'gpt-5.5',label:'GPT-5.5',reasoningEfforts:['low','high'],defaultReasoningEffort:'low'},
    {value:'claude-x',label:'Claude X',reasoningEfforts:['high','max']},
    {value:'gpt-4o',label:'GPT-4o'},
  ];
  const state = {entries:[{provider:'chatgpt-oauth',identity:await api.catalogIdentity('chatgpt-oauth','header'),fetchedAt:Date.now(),models}]};
  api.cachedCatalog(state,'chatgpt-oauth',state.entries[0].identity);
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth','gpt-5.5','high'),'GPT-5.5 · high');
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth','gpt-5.5',''),'GPT-5.5 · low (default)');
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth','gpt-5.5','max'),'GPT-5.5 · low (default)');
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth','claude-x',''),'Claude X · default');
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth','gpt-4o','high'),'GPT-4o');
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth','custom-id','high'),'custom-id');
});

test('Settings: "Custom..." is UI state only and never saves an empty model', async () => {
  for (const provider of ['openai','anthropic']) {
    let saves = 0;
    const plugin = {settings:{...settings(provider)},saveSettings:async()=>{saves++;}};
    const original = plugin.settings.model;
    const tab = new api.ChatSettingTab({},plugin);
    let refreshes = 0; tab.update = ()=>{refreshes++;};
    const render = () => { globalThis.__settingRows = []; tab.renderModelSection(new api.Setting()); if (tab.editingCustomModel) tab.renderCustomModel(new api.Setting()); return globalThis.__settingRows; };
    let rows = render();
    let dropdown = rows[0].controls[0];
    assert.equal(dropdown.value, original);
    assert.ok(dropdown.options.some(([value, label]) => value === '__custom__' && label === 'Custom...'));
    assert.equal(rows.some(row => row.name === 'Custom model ID'), false);
    await dropdown.change('__custom__');
    assert.equal(plugin.settings.model, original);
    assert.equal(saves, 0);
    assert.equal(refreshes, 1);
    rows = render();
    dropdown = rows[0].controls[0];
    assert.equal(dropdown.value, '__custom__');
    const field = rows.find(row => row.name === 'Custom model ID').controls[0];
    assert.equal(field.placeholder, provider === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6');
    assert.equal(field.value, original);
    await field.change('   ');
    assert.equal(plugin.settings.model, original);
    assert.equal(saves, 0);
    await field.change(' future-model ');
    assert.equal(plugin.settings.model, 'future-model');
    assert.equal(saves, 1);
    rows = render();
    assert.ok(rows[0].controls[0].options.some(([value, label]) => value === 'future-model' && label === 'future-model (current)'));
    await rows[0].controls[0].change(original);
    assert.equal(plugin.settings.model, original);
    assert.equal(render().some(row => row.name === 'Custom model ID'), false);
  }
});

test('Chat history is not saved before the saved chat has been read', async () => {
  const { app } = vaultApp();
  const writes = [];
  let finishRead;
  app.vault.adapter = { read: path => path.endsWith('.next.json') ? Promise.reject(new Error('ENOENT')) : new Promise(resolve => { finishRead = resolve; }), write: async (path, data) => { if (!path.endsWith('.next.json')) writes.push(JSON.parse(data)); } };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('openai'));
  const loading = plugin.loadChatHistory();
  // Unloading while the read is pending must not overwrite the saved chat.
  plugin.onunload();
  await plugin.saveChatHistory();
  assert.deepEqual(writes, []);
  finishRead(JSON.stringify({ chatHistory: [{ type: 'user', text: 'Saved question' }], agentMessages: [{ role: 'user', content: 'Saved question' }] }));
  await loading;
  await plugin.saveChatHistory();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].conversations[0].chatHistory[0].text, 'Saved question');
  // Without a saved file yet, saving is allowed once the read has failed.
  const fresh = new api.ChatPlugin();
  fresh.app = { vault: { configDir: '.obsidian', adapter: { read: async () => { throw new Error('ENOENT'); }, exists: async () => false, write: async (path, data) => { if (!path.endsWith('.next.json')) writes.push(JSON.parse(data)); } } } };
  fresh.agent = new api.AgentLoop(app, settings('openai'));
  await fresh.loadChatHistory();
  await fresh.saveChatHistory();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].conversations[0].chatHistory, []);
});

test('ChatGPT: citation markers in the text (private-use characters) are left out of the shown answer, kept in the replay', async () => {
  const marked = 'A balanced pile smells earthy. citeturn0search0\n\nTurn it weekly.citeturn0search1';
  const deltas = [];
  transport(() => response('chatgpt-oauth', [text(marked)]));
  const cb = callbacks({ onTextDelta: delta => deltas.push(delta) });
  const agent = new api.AgentLoop(vaultApp().app, settings('chatgpt-oauth'));
  await agent.run('Compost?', cb);
  assert.deepEqual(cb.texts, ['A balanced pile smells earthy.\n\nTurn it weekly.']);
  assert.doesNotMatch(deltas.join(''), /[-]/);
  assert.match(JSON.stringify(agent.exportMessages().at(-1).replay.items), /turn0search0/);
});
