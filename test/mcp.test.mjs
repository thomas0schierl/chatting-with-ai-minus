// Remote MCP servers through the provider (ADR-19): what each provider's
// request names, the calls it reports shown as steps, nothing for the
// ChatGPT plan, and tokens kept out of data.json.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, sse, streamEvents, text, transport, settings, callbacks, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

const SERVERS = [
  { id: 'a', name: 'linear', url: 'https://mcp.linear.app/sse', enabled: true, token: 'secret-token' },
  { id: 'b', name: 'off', url: 'https://off.example/mcp', enabled: false },
  { id: 'c', name: 'bad name!', url: 'https://x.example', enabled: true },
  { id: 'd', name: 'plain', url: 'http://insecure.example', enabled: true },
];

test('Anthropic: enabled valid servers as mcp_servers with a toolset each and the beta header; calls shown as steps', async () => {
  const headers = [];
  const requests = transport((body, index, request) => {
    headers.push(request.headers['anthropic-beta']);
    return sse(streamEvents('anthropic', [
      { type: 'mcp_tool_use', id: 'm1', name: 'create_issue', server_name: 'linear', input: { title: 'Fix tiles' } },
      { type: 'mcp_tool_result', tool_use_id: 'm1', is_error: false, content: [{ type: 'text', text: 'Created ENG-12' }] },
      text('Done: ENG-12'),
    ]));
  });
  const steps = [];
  const cb = callbacks({ onToolCall: (name, input) => steps.push(['call', name, input]), onToolResult: (name, result) => steps.push(['result', name, result]) });
  await new api.AgentLoop(vaultApp().app, { ...settings('anthropic'), enableWebSearch: false, mcpServers: SERVERS }).run('File a bug', cb);

  assert.deepEqual(requests[0].mcp_servers, [{ type: 'url', url: 'https://mcp.linear.app/sse', name: 'linear', authorization_token: 'secret-token' }]);
  assert.deepEqual(requests[0].tools.at(-1), { type: 'mcp_toolset', mcp_server_name: 'linear' });
  assert.equal(headers[0], 'mcp-client-2025-11-20');
  assert.deepEqual(steps, [
    ['call', 'mcp:linear:create_issue', { title: 'Fix tiles' }],
    ['result', 'mcp:linear:create_issue', { result: 'Created ENG-12', isError: false }],
  ]);
  assert.deepEqual(cb.texts, ['Done: ENG-12']);
  // Kept for replay as the provider sent them.
  assert.equal(requests.length, 1);
});

test('OpenAI: one mcp tool per server, without approvals; mcp_call items shown as steps, an error as a failed step', async () => {
  const requests = transport(() => sse(streamEvents('openai', [
    { type: 'mcp_list_tools', id: 'l1', server_label: 'linear', tools: [] },
    { type: 'mcp_call', id: 'c1', server_label: 'linear', name: 'search', arguments: '{"q":"tiles"}', output: '3 issues' },
    { type: 'mcp_call', id: 'c2', server_label: 'linear', name: 'delete', arguments: '{}', error: 'Not allowed' },
    text('Found 3'),
  ])));
  const steps = [];
  await new api.AgentLoop(vaultApp().app, { ...settings('openai'), enableWebSearch: false, mcpServers: SERVERS })
    .run('Search', callbacks({ onToolResult: (name, result) => steps.push([name, result]) }));
  assert.deepEqual(requests[0].tools.filter(tool => tool.type === 'mcp'), [
    { type: 'mcp', server_label: 'linear', server_url: 'https://mcp.linear.app/sse', require_approval: 'never', authorization: 'secret-token' },
  ]);
  assert.deepEqual(steps, [
    ['mcp:linear:search', { result: '3 issues', isError: false }],
    ['mcp:linear:delete', { result: 'Not allowed', isError: true }],
  ]);
});

test('The ChatGPT plan gets no MCP servers', async () => {
  const requests = transport(() => sse(streamEvents('chatgpt-oauth', [text('ok')])));
  await new api.AgentLoop(vaultApp().app, { ...settings('chatgpt-oauth'), mcpServers: SERVERS }).run('Hi', callbacks());
  assert.doesNotMatch(JSON.stringify(requests[0]), /mcp|linear/);
});

test('Labels: used tool and server', () => {
  const label = api.toolLabels.toolLabel;
  assert.equal(label('mcp:linear:create_issue', {}, 'done'), 'Used create_issue on linear');
  assert.equal(label('mcp:linear:delete', {}, 'error'), 'Using delete on linear failed');
});

test('Tokens go to SecretStorage only; data.json keeps name, address and on/off', async () => {
  const secrets = new Map();
  let saved;
  const plugin = new api.ChatPlugin();
  plugin.app = { secretStorage: { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) }, workspace: { getLeavesOfType: () => [] } };
  plugin.loadData = async () => ({ mcpServers: [{ id: 'a', name: 'linear', url: 'https://mcp.linear.app/sse', enabled: true, token: 'from-data-json' }] });
  plugin.saveData = async data => { saved = JSON.parse(JSON.stringify(data)); };
  secrets.set('chatting-with-ai-minus-mcp-a', 'kept-secret');
  await plugin.loadSettings();
  assert.equal(plugin.settings.mcpServers[0].token, 'kept-secret');

  plugin.settings.mcpServers[0].token = 'new-secret';
  await plugin.saveSettings();
  assert.deepEqual(saved.mcpServers, [{ id: 'a', name: 'linear', url: 'https://mcp.linear.app/sse', enabled: true }]);
  assert.equal(secrets.get('chatting-with-ai-minus-mcp-a'), 'new-secret');

  await plugin.removeMcpServer('a');
  assert.deepEqual(saved.mcpServers, []);
  assert.equal(secrets.get('chatting-with-ai-minus-mcp-a'), '');
});
