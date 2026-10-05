// Live voice (ADR-11, ADR-14): session creation on both routes, the two
// event dialects, delegation through the real chat view, microphone modes,
// ending, and the Codex sign-in. WebRTC, the microphone and the audio
// element are faked here.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, text, call, response, chatSetup } from './harness.mjs';

const { voiceProtocol: P, voiceSession: S, voiceController: C, codexVoice: X } = api;

// ─── Fake WebRTC, microphone and audio ──────────────────────────────────────

class FakeTrack { enabled = true; stopped = false; stop() { this.stopped = true; } }
class FakeStream {
  constructor() { this.track = new FakeTrack(); }
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}
class FakeChannel {
  readyState = 'connecting';
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; queueMicrotask(() => this.onclose?.()); }
  open() { this.readyState = 'open'; this.onopen?.(); }
  /** A server event arriving. */
  receive(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const rtc = { pcs: [], mic: null, constraints: null };
class FakePeerConnection {
  constructor() { rtc.pcs.push(this); this.tracks = []; this.iceGatheringState = 'new'; this.connectionState = 'new'; this.closed = false; }
  addTrack(track) { this.tracks.push(track); }
  createDataChannel(label) { this.label = label; return (this.channel = new FakeChannel()); }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async setLocalDescription(description) { this.localDescription = description; this.iceGatheringState = 'complete'; }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    setTimeout(() => { this.channel.open(); this.ontrack?.({ streams: [new FakeStream()], track: new FakeTrack() }); }, 0);
  }
  close() { this.closed = true; this.channel?.close(); }
}
globalThis.RTCPeerConnection = FakePeerConnection;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { userAgent: 'test', mediaDevices: { getUserMedia: async (constraints) => { rtc.constraints = constraints; return (rtc.mic = new FakeStream()); } } },
});
globalThis.createEl = () => ({ autoplay: false, srcObject: null, play: async () => {}, pause() {} });

const pc = () => rtc.pcs.at(-1);
const channel = () => pc().channel;
async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  rtc.pcs = [];
  Object.assign(S.SESSION_TIMING, { iceWait: 10, startWait: 1000, closeWait: 300, quietLog: 5 });
  Object.assign(C.VOICE_TIMING, { quiet: 20, maxWait: 200, speaking: 20 });
  api.resetStreamTransport();
  globalThis.__notices = [];
});

const OPENAI_KEY = 'chatting-with-ai-minus-api-key-openai';
const CODEX_KEY = 'chatting-with-ai-minus-codex-voice';
const liveAnswer = () => ({ status: 201, json: { session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } } });

/** A chat view with voice set up (OpenAI key, or with `codex` the Codex sign-in). */
async function voiceSetup({ codex = false, micMode = 'hands-free' } = {}) {
  const setup = await chatSetup('anthropic');
  const secrets = { [OPENAI_KEY]: 'sk-voice' };
  if (codex) secrets[CODEX_KEY] = JSON.stringify({ accessToken: 'codex-access', refreshToken: 'codex-refresh', accountId: 'acct_1', expiresAt: Date.now() + 3600_000, email: 'me@example.com' });
  setup.app.secretStorage = { getSecret: (key) => secrets[key] ?? '', setSecret: (key, value) => { secrets[key] = value; } };
  setup.plugin.settings = { ...setup.plugin.settings, voiceMicMode: micMode, voiceRoute: codex ? 'codex' : 'openai' };
  if (codex) setup.plugin.codexVoice = new X.CodexVoiceAuth(setup.app);
  return { ...setup, secrets };
}

/** Routes voice call requests to `live` and chat requests (Anthropic, SSE) to `chat`. */
function serve({ live = liveAnswer, chat = () => response('anthropic', [text('OK')]) } = {}) {
  const log = { live: [], chat: [] };
  globalThis.__providerRequest = async (request) => {
    if (request.url.includes('/live/sessions') || request.url.includes('/realtime/calls')) {
      log.live.push(request);
      return live(request);
    }
    const body = JSON.parse(request.body);
    log.chat.push(body);
    return chat(body, log.chat.length - 1);
  };
  return log;
}

/** Start voice in the view and wait until it listens (official route: after session.started). */
async function startListening(view, chat, { started = true } = {}) {
  const before = rtc.pcs.length;
  view.startVoice();
  await until(() => rtc.pcs.length > before && pc().channel?.readyState === 'open');
  if (started) channel().receive({ type: 'session.started', session: { id: 'live_1', expires_at: 0 } });
  await until(() => chat.voice?.status === 'listening');
}

const userText = (body) => {
  const last = body.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').at(-1);
  return last.content;
};

// ─── Session creation ───────────────────────────────────────────────────────

test('Official route: POST /v1/live/sessions with model, voice, client delegation, recent chat and the offer; the answer SDP is applied', async () => {
  const { view, plugin, chat } = await voiceSetup();
  plugin.chatHistory.push({ type: 'user', text: 'Earlier question', turnId: 't0' }, { type: 'assistant', text: 'Earlier answer' }, { type: 'error', text: 'ignored' });
  const log = serve();
  await startListening(view, chat);

  const request = log.live[0];
  assert.equal(request.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer sk-voice');
  assert.equal(request.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.body);
  assert.equal(body.session.model, 'gpt-live-1');
  assert.deepEqual(body.session.audio, { output: { voice: 'marin' } });
  assert.deepEqual(body.session.delegation, { type: 'client' });
  assert.match(body.session.instructions, /Delegate every request/);
  assert.deepEqual(body.session.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier question' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer' }] },
  ]);
  assert.deepEqual(body.transport, { type: 'webrtc', sdp: 'offer-sdp' });
  assert.deepEqual(pc().remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
  assert.equal(pc().label, 'oai-events');
  assert.deepEqual(rtc.constraints, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  assert.equal(chat.voice.micOn, true);
  view.endVoice();
});

test('Official route: an HTTP error ends voice with the API message in the chat', async () => {
  const { view, chat, plugin } = await voiceSetup();
  serve({ live: () => ({ status: 403, json: { error: { message: 'No access to gpt-live-1' } } }) });
  view.startVoice();
  await until(() => chat.shown.some((m) => m.type === 'error'));
  assert.match(chat.shown.at(-1).text, /HTTP 403.*No access to gpt-live-1/);
  assert.equal(plugin.chatHistory.at(-1).type, 'error');
  assert.equal(chat.voice, null);
  assert.equal(pc().closed, true);
  assert.equal(rtc.mic.track.stopped, true);
});

test('Codex route: POST to the realtime calls route with Codex headers; the call ID comes from Location', async () => {
  const auth = { usableCredential: async () => ({ accessToken: 'codex-access', accountId: 'acct_1', refreshToken: 'r', expiresAt: 0 }) };
  const requests = [];
  globalThis.__providerRequest = async (request) => {
    requests.push(request);
    return { status: 201, text: 'answer-sdp', headers: { location: '/v1/live/rtc_abc123' } };
  };
  const route = X.codexVoiceRoute(auth, 'ember', async () => '1.2.3');
  const items = P.seedItems([{ type: 'user', text: 'Hi' }]);
  const result = await route.connect({ sdp: 'offer-sdp', instructions: 'Be brief', items });

  assert.deepEqual(result, { sdp: 'answer-sdp', callId: 'rtc_abc123' });
  const [request] = requests;
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas');
  assert.equal(request.method, 'POST');
  const h = request.headers;
  assert.equal(h.Authorization, 'Bearer codex-access');
  assert.equal(h['ChatGPT-Account-ID'], 'acct_1');
  assert.equal(h['openai-alpha'], 'quicksilver=v2');
  assert.equal(h.originator, 'codex_cli_rs');
  assert.equal(h.version, '1.2.3');
  assert.match(h['User-Agent'], /^codex_cli_rs\/1\.2\.3 \(.+; .+\) obsidian$/);
  assert.match(h['x-session-id'], /^[0-9a-f-]{36}$/);
  assert.equal(h['session-id'], h['x-session-id']);
  assert.equal(h['thread-id'], h['x-session-id']);
  assert.deepEqual(JSON.parse(request.body), {
    sdp: 'offer-sdp',
    session: { instructions: 'Be brief', audio: { output: { voice: 'ember' } }, delegation: { type: 'client' }, model: 'gpt-live-1-codex', initial_items: items },
  });
  assert.equal(route.dialect, 'v3');
  assert.equal(route.waitForStarted, false);
});

// ─── Event parsing ──────────────────────────────────────────────────────────

test('Events of both dialects: transcripts, delegations with and without text, errors, closed', () => {
  const parse = P.parseVoiceEvent;
  assert.deepEqual(parse({ type: 'session.started', session: { id: 'x' } }), { kind: 'started' });
  assert.deepEqual(parse({ type: 'session.input_transcript.delta', delta: 'Hel' }), { kind: 'input', text: 'Hel' });
  assert.deepEqual(parse({ type: 'session.output_transcript.delta', delta: 'Sure' }), { kind: 'output', text: 'Sure' });
  assert.deepEqual(parse({ type: 'session.delegation.created', delegation: { id: 'del_1', type: 'delegation', target: 'client' } }), { kind: 'delegation', id: 'del_1', text: '' });
  assert.deepEqual(parse({ type: 'session.delegation.created', delegation: { id: 'del_2', target: 'responses' } }), { kind: 'other' });
  assert.deepEqual(parse({ type: 'error', error: { type: 'invalid_request_error', code: 'x', message: 'Bad event' } }), { kind: 'error', message: 'Bad event' });
  assert.deepEqual(parse({ type: 'session.closed', reason: 'expired' }), { kind: 'closed', reason: 'expired' });

  assert.deepEqual(parse({ type: 'input_transcript.added', item: { text: 'Find my' } }), { kind: 'input', text: 'Find my' });
  assert.deepEqual(parse({ type: 'output_transcript.added', item: { text: 'On it' } }), { kind: 'output', text: 'On it' });
  assert.deepEqual(parse({ type: 'turn.done', turn: { role: 'user', transcript: 'Find my note' } }), { kind: 'turn-done', role: 'user', text: 'Find my note' });
  assert.deepEqual(parse({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Find ' }, { type: 'input_text', text: 'my note' }] } }),
    { kind: 'delegation', id: 'it_1', text: 'Find my note' });
  assert.deepEqual(parse({ type: 'error', message: 'Plain message' }), { kind: 'error', message: 'Plain message' });
  assert.deepEqual(parse({ type: 'session.usage.updated' }), { kind: 'other' });
  assert.deepEqual(parse('nonsense'), { kind: 'other' });

  assert.equal(P.eventDialect('session.delegation.created'), 'live');
  assert.equal(P.eventDialect('delegation.created'), 'v3');
  assert.equal(P.eventDialect('session.started'), undefined);
});

test('Answers are chunked per dialect: commentary ≤1500 characters, Codex appends ≤500 bytes; long answers point to the chat', () => {
  const words = 'word '.repeat(500).trim();
  const live = P.speakEvents('live', 'del_1', words);
  assert.ok(live.length > 1);
  for (const event of live) {
    assert.equal(event.type, 'session.commentary.append');
    assert.equal(event.delegation_id, 'del_1');
    assert.ok(event.content.length <= 1500);
  }
  assert.equal(live.map((e) => e.content).join(' '), words);

  const japanese = '日本語のメモです。'.repeat(60);
  const v3 = P.speakEvents('v3', 'it_1', japanese);
  assert.ok(v3.length > 1);
  for (const event of v3) {
    assert.deepEqual(Object.keys(event), ['type', 'delegation_item_id', 'channel', 'content']);
    assert.equal(event.channel, 'speakable');
    assert.ok(new TextEncoder().encode(event.content[0].text).length <= 500);
  }
  assert.equal(v3.map((e) => e.content[0].text).join(''), japanese);
  assert.equal(P.progressEvents('v3', 'it_1', 'Reading')[0].channel, 'commentary');
  assert.equal(P.progressEvents('live', 'del_1', 'Reading')[0].type, 'session.thinking.append');

  const long = 'This is a sentence. '.repeat(300);
  const spoken = P.spokenAnswer(long);
  assert.ok(spoken.length < 3100);
  assert.match(spoken, /The full answer is in the chat\.$/);
  assert.equal(P.spokenAnswer('Short.'), 'Short.');
});

// ─── Delegation through the chat view ───────────────────────────────────────

test('Public delegation: the transcript gathered since the last one runs as a chat turn; progress and answer go back with the delegation ID', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({
    chat: (body, index) => index === 0
      ? response('anthropic', [text('Let me check.'), call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')
      : response('anthropic', [text('Your note says Original.')]),
  });
  await startListening(view, chat);

  const ch = channel();
  ch.receive({ type: 'session.input_transcript.delta', delta: 'What does my ' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_1', type: 'delegation', target: 'client' } });
  // The last words are transcribed after the delegation arrived.
  ch.receive({ type: 'session.input_transcript.delta', delta: 'note say?' });
  await until(() => ch.sent.some((e) => e.type === 'session.commentary.append'));

  const user = plugin.chatHistory.find((e) => e.type === 'user');
  assert.equal(user.text, 'What does my note say?');
  assert.ok(user.turnId);
  assert.match(userText(log.chat[0]), /This turn comes from a voice conversation/);
  assert.match(userText(log.chat[0]), /What does my note say\?$/);
  assert.equal(plugin.agent.exportMessages().find((m) => m.turnId)?.turnId, user.turnId);
  assert.ok(chat.shown.some((m) => m.type === 'tool-result'));
  assert.equal(plugin.chatHistory.at(-1).text, 'Your note says Original.');

  const thinking = ch.sent.filter((e) => e.type === 'session.thinking.append');
  assert.deepEqual(thinking.map((e) => [e.delegation_id, e.content]), [['del_1', 'Let me check.'], ['del_1', 'Working on it: read file.']]);
  assert.deepEqual(ch.sent.filter((e) => e.type === 'session.commentary.append'), [
    { type: 'session.commentary.append', delegation_id: 'del_1', content: 'Your note says Original.' },
  ]);
  await until(() => chat.voice?.status === 'listening');
  assert.equal(chat.voice.you, 'What does my note say?');
  view.endVoice();
});

test('Codex dialect: the delegation text runs as the turn; progress and the answer go back as ≤500-byte delegation.context.append chunks', async () => {
  const { view, plugin, chat } = await voiceSetup({ codex: true });
  const answer = '日本語のメモです。'.repeat(60);
  const log = serve({
    live: () => ({ status: 201, text: 'answer-sdp', headers: { Location: '/v1/live/rtc_1' } }),
    chat: (body, index) => index === 0
      ? response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')
      : response('anthropic', [text(answer)]),
  });
  // Codex's route doesn't wait for session.started.
  await startListening(view, chat, { started: false });
  assert.match(log.live[0].url, /backend-api\/codex\/realtime\/calls/);
  assert.equal(JSON.parse(log.live[0].body).session.audio.output.voice, 'cove');

  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Summarize my note' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Summarize the note' }] } });
  await until(() => ch.sent.some((e) => e.channel === 'speakable'));

  assert.equal(plugin.chatHistory.find((e) => e.type === 'user').text, 'Summarize the note');
  const progress = ch.sent.filter((e) => e.channel === 'commentary');
  assert.deepEqual(progress.map((e) => e.content[0].text), ['Working on it: read file.']);
  const spoken = ch.sent.filter((e) => e.channel === 'speakable');
  assert.ok(spoken.length > 1);
  for (const event of spoken) {
    assert.equal(event.type, 'delegation.context.append');
    assert.equal(event.delegation_item_id, 'it_1');
    assert.ok(new TextEncoder().encode(event.content[0].text).length <= 500);
  }
  assert.equal(spoken.map((e) => e.content[0].text).join(''), answer);
  view.endVoice();
});

test('A new delegation stops the running turn; only the new answer is spoken', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('Old answer')])); })
      : response('anthropic', [text('New answer')]),
  });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'session.input_transcript.delta', delta: 'First question' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
  await until(() => log.chat.length === 1);

  ch.receive({ type: 'session.input_transcript.delta', delta: 'Second question' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_2', target: 'client' } });
  await until(() => ch.sent.some((e) => e.type === 'session.commentary.append'));
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(ch.sent.filter((e) => e.type === 'session.commentary.append').map((e) => [e.delegation_id, e.content]), [['del_2', 'New answer']]);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text), ['First question', 'Second question']);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'assistant').map((e) => e.text), ['New answer']);
  assert.match(userText(log.chat[1]), /Second question$/);
  view.endVoice();
});

test('Ending voice lets a running turn finish in the chat without speaking it', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let release;
  serve({ chat: () => new Promise((resolve) => { release = () => resolve(response('anthropic', [text('Done anyway')])); }) });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'session.input_transcript.delta', delta: 'Do it' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
  await until(() => typeof release === 'function');
  view.endVoice();
  release();
  await until(() => plugin.chatHistory.some((e) => e.text === 'Done anyway'));
  assert.equal(ch.sent.filter((e) => e.type === 'session.commentary.append').length, 0);
});

// ─── Microphone and ending ──────────────────────────────────────────────────

test('Hold to talk: the microphone track is on only while pressed; hands-free mute toggles it', async () => {
  const held = await voiceSetup({ micMode: 'hold' });
  serve();
  await startListening(held.view, held.chat);
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(held.chat.voice.holdToTalk, true);
  held.view.handleVoice('talk-start');
  assert.equal(rtc.mic.track.enabled, true);
  assert.equal(held.chat.voice.micOn, true);
  held.view.handleVoice('talk-end');
  assert.equal(rtc.mic.track.enabled, false);
  held.view.endVoice();

  const free = await voiceSetup();
  serve();
  await startListening(free.view, free.chat);
  assert.equal(rtc.mic.track.enabled, true);
  free.view.handleVoice('talk-start');
  assert.equal(rtc.mic.track.enabled, true);
  free.view.handleVoice('mute');
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(free.chat.voice.micOn, false);
  free.view.handleVoice('mute');
  assert.equal(rtc.mic.track.enabled, true);
  free.view.endVoice();
});

test('End sends session.close and closes on session.closed, or after the timeout', async () => {
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  const first = pc();
  const started = Date.now();
  view.endVoice();
  assert.equal(chat.voice, null);
  assert.deepEqual(first.channel.sent.at(-1), { type: 'session.close' });
  first.channel.receive({ type: 'session.closed', reason: 'close_requested' });
  await until(() => first.closed);
  assert.ok(Date.now() - started < 200);
  assert.equal(rtc.mic.track.stopped, true);
  assert.equal(chat.shown.filter((m) => m.type === 'error').length, 0);

  await startListening(view, chat);
  const second = pc();
  const again = Date.now();
  view.endVoice();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(second.closed, false);
  await until(() => second.closed);
  assert.ok(Date.now() - again >= 250);
});

test('The server ending the session shows why; a new chat ends voice', async () => {
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  channel().receive({ type: 'session.closed', reason: 'expired' });
  await until(() => chat.voice === null);
  assert.match(chat.shown.at(-1).text, /ended \(expired\)/);
  assert.equal(pc().closed, true);

  await startListening(view, chat);
  const ch = channel();
  view.newChat();
  assert.equal(chat.voice, null);
  assert.deepEqual(ch.sent.at(-1), { type: 'session.close' });
  await until(() => pc().closed);
});

test('The microphone button shows only when a voice route is set up', async () => {
  const { view, plugin, chat, secrets } = await voiceSetup();
  view.updateVoiceAvailable();
  assert.equal(chat.voiceAvailable, true);
  secrets[OPENAI_KEY] = '';
  view.updateVoiceAvailable();
  assert.equal(chat.voiceAvailable, false);
  plugin.settings.voiceRoute = 'codex';
  plugin.codexVoice = new X.CodexVoiceAuth(plugin.app);
  view.updateVoiceAvailable();
  assert.equal(chat.voiceAvailable, false);
  secrets[CODEX_KEY] = JSON.stringify({ accessToken: 'a', refreshToken: 'r', accountId: 'acct', expiresAt: Date.now() + 3600_000 });
  view.updateVoiceAvailable();
  assert.equal(chat.voiceAvailable, true);
});

// ─── Codex sign-in ──────────────────────────────────────────────────────────

const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const authClaims = { email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } };

function secretApp() {
  const secrets = {};
  return { secrets, app: { secretStorage: { getSecret: (key) => secrets[key] ?? '', setSecret: (key, value) => { secrets[key] = value; } } } };
}

test('Codex sign-in: device code, polling while pending, code exchange; tokens only in SecretStorage', async () => {
  const { app, secrets } = secretApp();
  const auth = new X.CodexVoiceAuth(app);
  const requests = [];
  let polls = 0;
  globalThis.__providerRequest = async (request) => {
    requests.push(request);
    if (request.url.endsWith('/deviceauth/usercode')) return { status: 200, json: { device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '0' } };
    if (request.url.endsWith('/deviceauth/token')) return ++polls < 3 ? { status: 403, json: {} } : { status: 200, json: { authorization_code: 'code_1', code_verifier: 'verifier_1' } };
    if (request.url === 'https://auth.openai.com/oauth/token') return { status: 200, json: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: 'refresh_1', id_token: jwt(authClaims), expires_in: 3600 } };
    throw new Error(`Unexpected ${request.url}`);
  };

  const code = await auth.startDeviceSignIn();
  assert.deepEqual(code, { deviceAuthId: 'dev_1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', intervalMs: 0 });
  assert.equal(requests[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
  assert.deepEqual(JSON.parse(requests[0].body), { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });

  const credential = await auth.completeDeviceSignIn(code);
  const polled = requests.filter((r) => r.url.endsWith('/deviceauth/token'));
  assert.equal(polled.length, 3);
  assert.deepEqual(JSON.parse(polled[0].body), { device_auth_id: 'dev_1', user_code: 'ABCD-1234' });
  const exchange = requests.at(-1);
  assert.equal(exchange.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange.body)), {
    grant_type: 'authorization_code', code: 'code_1', redirect_uri: 'https://auth.openai.com/deviceauth/callback',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code_verifier: 'verifier_1',
  });
  assert.equal(credential.accountId, 'acct_1');
  assert.equal(credential.email, 'me@example.com');
  assert.deepEqual(Object.keys(secrets), [CODEX_KEY]);
  assert.equal(JSON.parse(secrets[CODEX_KEY]).refreshToken, 'refresh_1');
  assert.equal(auth.getCredential().accountId, 'acct_1');

  auth.signOut();
  assert.equal(auth.getCredential(), null);
});

test('Codex sign-in refreshes within 5 minutes of expiry with a JSON body and keeps the account', async () => {
  const { app, secrets } = secretApp();
  secrets[CODEX_KEY] = JSON.stringify({ accessToken: 'old', refreshToken: 'refresh_1', idToken: jwt(authClaims), accountId: 'acct_1', email: 'me@example.com', expiresAt: Date.now() + 60_000 });
  const auth = new X.CodexVoiceAuth(app);
  const requests = [];
  globalThis.__providerRequest = async (request) => {
    requests.push(request);
    return { status: 200, json: { access_token: 'new', expires_in: 3600 } };
  };
  const [a, b] = await Promise.all([auth.usableCredential(), auth.usableCredential()]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].body), { grant_type: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: 'refresh_1' });
  assert.equal(a.accessToken, 'new');
  assert.equal(b.accessToken, 'new');
  assert.equal(a.refreshToken, 'refresh_1');
  assert.equal(a.accountId, 'acct_1');

  // Valid for more than 5 minutes: no request.
  assert.equal((await auth.usableCredential()).accessToken, 'new');
  assert.equal(requests.length, 1);
});
