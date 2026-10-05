// Shared test harness: bundles the real plugin modules with a fake Obsidian
// API and transport. Test files import what they need from here.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Bundle the actual production adapters/loop; only transport and the vault are fake.
export const bundled = await build({
  stdin: { contents: `
    export { ChatSettingTab, getModelHeaderLabel } from './src/settings';
    export * from './src/api/model-catalog';
    export { sendMessage } from './src/api/client';
    export { AgentLoop } from './src/agent/loop';
    export { trimHistory } from './src/agent/history';
    export * as chatState from './src/chat-state';
    export { sendAnthropicMessage } from './src/api/anthropic';
    export { sendOpenAIMessage, clearOpenAIState } from './src/api/openai';
    export { sendChatGPTOAuthMessage, setChatGPTOAuthService } from './src/api/chatgpt-oauth';
    export { buildResponsesInput, fromResponsesOutput } from './src/api/responses-format';
    export { streamSSE, createSSEParser, resetStreamTransport } from './src/api/stream';
    export { default as ChatPlugin } from './src/main';
    export { ObsidianChatView } from './src/ui/chat-view';
    export { executeTool } from './src/tools/executor';
    export * as canvasRender from './src/tools/canvas-render';
    export * as auth from './src/auth/chatgptOAuth';
    export { ChatGPTOAuthStore } from './src/auth/chatgptOAuthStore';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'obsidian-test-transport', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
    // The chat view's Svelte UI isn't under test; main.ts only needs it to import.
    build.onResolve({ filter: /^svelte$|\.svelte$/ }, () => ({ path: 'svelte', namespace: 'test-svelte' }));
    build.onLoad({ filter: /.*/, namespace: 'test-svelte' }, () => ({ contents: 'export const mount = () => ({}); export const unmount = () => {}; export default {};', loader: 'js' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      export class App {}
      export class Plugin {}
      export class ItemView {}
      export class Menu {}
      export class Modal {}
      export class PluginSettingTab { hide() {} }
      // Records rendered rows and their controls in globalThis.__settingRows.
      export class Setting {
        constructor() { this.controls = []; (globalThis.__settingRows ??= []).push(this); }
        setName(name) { this.name = name; return this; }
        setDesc(desc) { this.desc = desc; return this; }
        control(fn) {
          const c = { options: [], inputEl: {}, addOption(v, l) { c.options.push([v, l]); return c; }, setValue(v) { c.value = v; return c; },
            setPlaceholder(p) { c.placeholder = p; return c; }, onChange(f) { c.change = f; return c; }, onClick(f) { c.click = f; return c; },
            setIcon() { return c; }, setTooltip() { return c; }, setDisabled() { return c; }, setButtonText() { return c; } };
          this.controls.push(c); fn(c); return this;
        }
        addDropdown(fn) { return this.control(fn); }
        addText(fn) { return this.control(fn); }
        addButton(fn) { return this.control(fn); }
      }
      export const requireApiVersion = () => globalThis.__supportsNewObsidian === true;
      // Shown notices are recorded in globalThis.__notices.
      export class Notice { constructor(message) { (globalThis.__notices ??= []).push(message); } }
      export const Platform = { isDesktopApp: true, isMobile: false, isIosApp: false, isAndroidApp: false };
      export class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
      export const normalizePath = path => path;
      // GitHub (Codex version lookup) is answered here so provider mocks only
      // see provider requests; a test may set __githubRequest.
      export const requestUrl = request => request.url.startsWith('https://api.github.com/')
        ? (globalThis.__githubRequest ?? (async () => ({ status: 503, json: {} })))(request)
        : globalThis.__providerRequest(request);
      export const arrayBufferToBase64 = buffer => Buffer.from(buffer).toString('base64');
    `, loader: 'js' }));
  } }],
});
export const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
export const settings = provider => ({ provider, model: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.5', apiKey: 'fake-test-key', maxIterations: 20, enableWebSearch: true });
export const image = { id: 'image', fileName: 'test.png', mediaType: 'image/png', data: 'fake-base64', sizeBytes: 1 };
export const text = value => ({ type: 'text', text: value });
export const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const result = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
export const assistant = response => ({ role: 'assistant', content: response.content, replay: response.replay });
export const responseMessage = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value, annotations: [] }] });
export const nativeCall = (id, name, input) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) });
// A provider's streamed answer for these blocks, through requestUrl() (the
// fake fetch below fails, so adapters fall back to it).
export function response(provider, blocks, stop = 'end_turn', index = 0) {
  return sse(streamEvents(provider, blocks, stop, index));
}
// The non-streamed Responses API object for these blocks.
export function responsesData(blocks, stop = 'end_turn', index = 0) {
  const output = blocks.map(block => block.type === 'text' ? responseMessage(block.text) : block.type === 'tool_use' ? nativeCall(block.id, block.name, block.input) : block);
  return { id: `resp_${index}`, output, status: stop === 'max_tokens' ? 'incomplete' : 'completed' };
}
const halves = value => [value.slice(0, Math.ceil(value.length / 2)), value.slice(Math.ceil(value.length / 2))].filter(Boolean);
// The SSE events a provider streams for these blocks (Anthropic Messages or Responses API).
export function streamEvents(provider, blocks, stop = 'end_turn', index = 0) {
  if (provider === 'anthropic') {
    const events = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
    blocks.forEach((block, index) => {
      const { text, thinking, signature, input, citations, ...rest } = block;
      const delta = value => events.push({ type: 'content_block_delta', index, delta: value });
      if (block.type === 'text') {
        events.push({ type: 'content_block_start', index, content_block: { ...rest, text: '' } });
        for (const citation of citations ?? []) delta({ type: 'citations_delta', citation });
        for (const part of halves(text)) delta({ type: 'text_delta', text: part });
      } else if (block.type === 'thinking') {
        events.push({ type: 'content_block_start', index, content_block: { ...rest, thinking: '', signature: '' } });
        for (const part of halves(thinking)) delta({ type: 'thinking_delta', thinking: part });
        delta({ type: 'signature_delta', signature });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        events.push({ type: 'content_block_start', index, content_block: { ...rest, input: {} } });
        for (const part of halves(JSON.stringify(input))) delta({ type: 'input_json_delta', partial_json: part });
      } else {
        events.push({ type: 'content_block_start', index, content_block: block });
      }
      events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
    return events;
  }
  const data = responsesData(blocks, stop, index);
  const events = [{ type: 'response.created', response: { id: data.id, status: 'in_progress', output: [] } }];
  data.output.forEach((item, output_index) => {
    for (const part of item.type === 'message' ? item.content : []) {
      if (part.type === 'output_text') for (const delta of halves(part.text)) events.push({ type: 'response.output_text.delta', output_index, delta });
    }
    events.push({ type: 'response.output_item.done', item, output_index });
  });
  // The ChatGPT route (store: false) sends the final response without output.
  events.push({ type: stop === 'max_tokens' ? 'response.incomplete' : 'response.completed', response: provider === 'openai' ? data : { ...data, output: [] } });
  return events;
}
export const sseText = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
export function sse(events) {
  return { status: 200, text: sseText(events), get json() { throw new SyntaxError('iOS lazy JSON getter'); } };
}
// fetch fails like a CORS block unless a test sets __fetch.
globalThis.fetch = async (url, init) => {
  if (globalThis.__fetch) return globalThis.__fetch(url, init);
  throw new TypeError('Failed to fetch');
};
export function transport(handler) {
  const requests = [];
  globalThis.__providerRequest = async request => {
    const body = JSON.parse(request.body);
    requests.push(body);
    return handler(body, requests.length - 1, request);
  };
  return requests;
}
export function vaultApp() {
  const files = new Map([['Cases/Case Template.md', '# Template\n日本語本文'], ['Untitled.md', 'Original']]);
  const app = {
    workspace: { getActiveFile: () => ({ path: 'Untitled.md' }) },
    vault: {
      configDir: '.obsidian', adapter: { append: async () => {} },
      getName: () => 'Test vault',
      getMarkdownFiles: () => [...files.keys()].map(path => ({ path })),
      getFileByPath: path => files.has(path) ? { path } : null,
      getFolderByPath: () => ({}),
      cachedRead: async file => files.get(file.path),
      create: async (path, content) => { assert.ok(!files.has(path)); files.set(path, content); return { path }; },
      process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
      modify: async (file, content) => { files.set(file.path, content); },
    },
  };
  return { app, files };
}
// Settings whose persisted catalog belongs to the fake credentials used by these tests.
export async function withCatalog(provider, models, extra = {}) {
  const identity = await api.catalogIdentity(provider, provider === 'chatgpt-oauth' ? 'fake-account' : 'fake-test-key');
  return { ...settings(provider), modelCatalog: { entries: [{ provider, identity, fetchedAt: Date.now(), models }] }, ...extra };
}
export function callbacks(extra = {}) {
  const errors = [], texts = [], executed = [];
  return { errors, texts, executed, onThinking() {}, onToolCall(name) { executed.push(name); }, onToolResult() {}, onResponse(value) { texts.push(value); }, onAskUser: async () => 'yes', onError(error) { errors.push(error); }, ...extra };
}
// Stands in for ChatContainer.svelte: keeps the shown messages like it does.
export function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    assistantAdds: [],
    askUser: null,
    addUserMessage(value, images = [], turnId, selection) { chat.shown.push({ id: nextId++, type: 'user', text: value, images, turnId, selection }); },
    addAssistantMessage(value, streaming = false) {
      chat.assistantAdds.push({ text: value, streaming });
      chat.shown.push({ id: nextId, type: 'assistant', text: value, streaming });
      return nextId++;
    },
    updateAssistantMessage(id, value, final = false) {
      const msg = chat.shown.find(m => m.id === id);
      if (msg) { msg.text = value; if (final) msg.streaming = false; }
    },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) {
      const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId);
      if (index >= 0) chat.shown.splice(index);
    },
    addToolCall(name) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    showAskUser(question) { chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy(value) { chat.busy = value; },
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle(value) { chat.title = value; }, setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin with a fresh (or the given saved) chat, its view, and the saved states.
export async function chatSetup(provider, saved) {
  const { app, files } = vaultApp();
  const writes = [];
  app.vault.adapter = {
    append: async () => {},
    read: async () => { if (!saved) throw new Error('ENOENT'); return JSON.stringify(saved); },
    write: async (path, data) => { writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings(provider));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { app, files, plugin, view, chat, writes };
}

