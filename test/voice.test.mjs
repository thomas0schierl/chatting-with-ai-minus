// Live voice (ADR-11, ADR-14): session creation on both routes, the two
// event dialects, delegation through the real chat view, microphone modes,
// ending, and the Codex sign-in. WebRTC, the microphone and the audio
// element are faked here.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, text, call, response, chatSetup } from './harness.mjs';

const { voiceProtocol: P, voiceSession: S, voiceController: C, codexVoice: X } = api;
const { appLifecycle } = api.lifecycle;

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
  Object.assign(S.SESSION_TIMING, { iceWait: 10, iceSettle: 5, startWait: 1000, closeWait: 300, quietLog: 5 });
  Object.assign(C.VOICE_TIMING, { quiet: 20, maxWait: 200, speaking: 20, reconnectAfter: 40, endAfter: 150 });
  appLifecycle.markVisible();
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

test('Device check: GPT-Live is listed, one session starts and is closed at once', async () => {
  const requests = [];
  let models = ['gpt-5.5'];
  globalThis.__providerRequest = async (request) => {
    requests.push(request.url);
    if (request.url === 'https://api.openai.com/v1/models') return { status: 200, json: { data: models.map((id) => ({ id })) } };
    if (request.url === 'https://api.openai.com/v1/live/sessions') return liveAnswer();
    throw new Error(`Unexpected ${request.url}`);
  };
  assert.deepEqual(await api.checkLiveVoice(''), ['skip', 'needs an OpenAI API key']);
  const [status, detail] = await api.checkLiveVoice('sk-voice');
  assert.equal(status, 'fail');
  assert.match(detail, /gpt-live-1 isn't in \/v1\/models/);
  assert.deepEqual(requests, ['https://api.openai.com/v1/models']);

  models = ['gpt-5.5', 'gpt-live-1'];
  const checking = api.checkLiveVoice('sk-voice');
  await until(() => pc()?.channel?.readyState === 'open');
  channel().receive({ type: 'session.started', session: { id: 'live_1' } });
  await until(() => channel().sent.some((event) => event.type === 'session.close'));
  channel().receive({ type: 'session.closed' });
  const result = await checking;
  assert.equal(result[0], 'ok');
  assert.match(result[1], /gpt-live-1: session live_1 started .* then closed; events: session\.started, session\.closed/);
  assert.equal(pc().closed, true);
  assert.equal(rtc.mic.track.stopped, true);
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

test('Codex route: prepare() starts the sign-in check and version lookup at once; connect() uses them, a later call checks again', async () => {
  let credentialChecks = 0;
  let versionLookups = 0;
  const auth = { usableCredential: async () => { credentialChecks++; return { accessToken: 'a', accountId: 'acct_1', refreshToken: 'r', expiresAt: 0 }; } };
  globalThis.__providerRequest = async () => ({ status: 201, text: 'answer-sdp', headers: { location: '/v1/live/rtc_1' } });
  const route = X.codexVoiceRoute(auth, 'ember', async () => { versionLookups++; return '1.2.3'; });

  route.prepare();
  assert.equal(credentialChecks, 1);
  assert.equal(versionLookups, 1);
  await route.connect({ sdp: 'offer', instructions: 'x', items: [] });
  assert.equal(credentialChecks, 1);
  assert.equal(versionLookups, 1);
  await route.connect({ sdp: 'offer', instructions: 'x', items: [] });
  assert.equal(credentialChecks, 2);
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
  // As in a mobile WebView without crypto.randomUUID().
  const randomUUID = crypto.randomUUID;
  crypto.randomUUID = undefined;
  let result;
  try {
    result = await route.connect({ sdp: 'offer-sdp', instructions: 'Be brief', items });
  } finally {
    crypto.randomUUID = randomUUID;
  }

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
  assert.match(h['x-session-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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

test('The live caption holds only the current words: cleared once the voice answers, not restored by a late user turn', async () => {
  const { view, chat } = await voiceSetup({ codex: true });
  serve({});
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Hello there' } });
  assert.equal(chat.voice.you, 'Hello there');
  ch.receive({ type: 'output_transcript.added', item: { text: 'Hi!' } });
  assert.equal(chat.voice.you, '');
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Hello there' } });
  assert.equal(chat.voice.you, '');
  ch.receive({ type: 'input_transcript.added', item: { text: 'Next' } });
  assert.equal(chat.voice.you, 'Next');
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

test('As in Codex: what was said since the last request goes with the next one (the voice asked first, the user answered)', async () => {
  const { view, plugin, chat } = await voiceSetup({ codex: true });
  const log = serve({
    live: () => ({ status: 201, text: 'answer-sdp', headers: { Location: '/v1/live/rtc_1' } }),
    chat: () => response('anthropic', [text('Added the heading test.')]),
  });
  await startListening(view, chat, { started: false });
  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Ask me what the heading should be called, ' } });
  ch.receive({ type: 'input_transcript.added', item: { text: 'then add it.' } });
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Ask me what the heading should be called, then add it.' } });
  ch.receive({ type: 'output_transcript.added', item: { text: 'What should the heading be called?' } });
  ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'What should the heading be called?' } });
  ch.receive({ type: 'input_transcript.added', item: { text: 'Test.' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'test' }] } });
  await until(() => ch.sent.some((e) => e.channel === 'speakable'));
  // The user turn reported late is the request already taken: not context next time.
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Test.' } });

  const sent = userText(log.chat[0]);
  assert.match(sent, /Said in the voice conversation before this request \(context\): User: "Ask me what the heading should be called, then add it\." Voice: "What should the heading be called\?"\./);
  assert.match(sent, /\ntest$|\] test$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Ask me what the heading should be called, then add it.', false], ['test', true]]);

  // The next request carries only what was said after this one.
  ch.receive({ type: 'output_transcript.added', item: { text: 'Done.' } });
  ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Done.' } });
  ch.receive({ type: 'input_transcript.added', item: { text: 'Now remove it.' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_2', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Remove the heading test' }] } });
  await until(() => log.chat.length === 2);
  const next = userText(log.chat[1]);
  assert.match(next, /\(context\): Voice: "Done\." User: "Now remove it\."\./);
  assert.doesNotMatch(next, /Ask me|Test\./);
  // "Now remove it." is the request as the voice put it: the chat shows the request only.
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text).slice(2), ['Remove the heading test']);
  view.endVoice();
});

test('A new request while the voice turn runs steers it with what was said before it', async () => {
  const { view, chat } = await voiceSetup({ codex: true });
  let releaseFirst;
  const log = serve({
    live: () => ({ status: 201, text: 'answer-sdp', headers: { Location: '/v1/live/rtc_1' } }),
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
      : response('anthropic', [text('Done.')]),
  });
  await startListening(view, chat, { started: false });
  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Add a section' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Add a section' }] } });
  await until(() => log.chat.length === 1);
  ch.receive({ type: 'input_transcript.added', item: { text: 'Call the other one notes-notes' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_2', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Also add a section notes-notes' }] } });
  await until(() => chat.queued?.length === 1);
  assert.deepEqual(chat.queued, ['Also add a section notes-notes']);
  releaseFirst();
  await until(() => log.chat.length === 2);
  assert.match(JSON.stringify(log.chat[1]), /\[The user added while you were working: Said in the voice conversation before this request \(context\): User: \\"Call the other one notes-notes\\"\.\] Also add a section notes-notes/);
  view.endVoice();
});

test('A new request while the voice turn runs steers it: nothing is stopped, the agent gets it after its current step', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
      : response('anthropic', [text('Added both sections.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'session.input_transcript.delta', delta: 'Add a Notes section' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
  await until(() => log.chat.length === 1);

  ch.receive({ type: 'session.input_transcript.delta', delta: 'Also add notes-notes' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_2', target: 'client' } });
  await until(() => ch.sent.some((e) => e.type === 'session.thinking.append' && e.delegation_id === 'del_2'));
  releaseFirst();
  await until(() => ch.sent.some((e) => e.type === 'session.commentary.append'));

  // One turn: the second request went out with the step after the tool.
  assert.equal(log.chat.length, 2);
  assert.match(JSON.stringify(log.chat[1]), /\[The user added while you were working:\] Also add notes-notes/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Add a Notes section', true], ['Also add notes-notes', false]]);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'assistant').map((e) => e.text), ['Added both sections.']);
  assert.deepEqual(ch.sent.filter((e) => e.type === 'session.commentary.append').map((e) => [e.delegation_id, e.content]),
    [['del_2', 'Added both sections.']]);
  view.endVoice();
});

test('While the agent waits for an answer to its question, the spoken request is that answer', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({
    chat: (body, index) => index === 0
      ? response('anthropic', [call('q1', 'ask_user', { question: 'Which name?' })], 'tool_use')
      : response('anthropic', [text('Added notes-notes.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'session.input_transcript.delta', delta: 'Add a section' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
  await until(() => chat.askUser);
  ch.receive({ type: 'session.input_transcript.delta', delta: 'notes-notes' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_2', target: 'client' } });
  await until(() => ch.sent.some((e) => e.type === 'session.commentary.append' && e.content === 'Added notes-notes.'));

  assert.equal(log.chat.length, 2);
  assert.match(JSON.stringify(log.chat[1]), /notes-notes/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Add a section', true], ['notes-notes', false]]);
  view.endVoice();
});

test('A request that arrives after the turn\'s last step runs as the next turn', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('First done.')])); })
      : response('anthropic', [text('Second done.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'session.input_transcript.delta', delta: 'First' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
  await until(() => log.chat.length === 1);
  ch.receive({ type: 'session.input_transcript.delta', delta: 'Second' });
  ch.receive({ type: 'session.delegation.created', delegation: { id: 'del_2', target: 'client' } });
  await until(() => ch.sent.some((e) => e.type === 'session.thinking.append' && e.delegation_id === 'del_2'));
  releaseFirst();
  await until(() => ch.sent.filter((e) => e.type === 'session.commentary.append').length === 2);

  assert.equal(log.chat.length, 2);
  assert.match(userText(log.chat[1]), /Second$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]), [['First', true], ['Second', true]]);
  assert.deepEqual(ch.sent.filter((e) => e.type === 'session.commentary.append').map((e) => e.content), ['First done.', 'Second done.']);
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

// ─── Background (ADR-15) ────────────────────────────────────────────────────

afterEach(() => { api.Platform.isMobileApp = false; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorsShown = (chat) => chat.shown.filter((m) => m.type === 'error').map((m) => m.text);

/** Voice listening on a phone, the peer connection up. */
async function phoneVoice(options) {
  api.Platform.isMobileApp = true;
  const setup = await voiceSetup(options);
  const log = serve();
  await startListening(setup.view, setup.chat);
  pc().connectionState = 'connected';
  return { ...setup, log, first: pc() };
}

test('Mobile: leaving turns the microphone off; back soon, the same call goes on with the microphone as it was', async () => {
  const { view, chat, first } = await phoneVoice();
  appLifecycle.markHidden();
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(chat.voice.micOn, true);
  appLifecycle.markVisible();
  assert.equal(rtc.pcs.length, 1);
  assert.equal(first.closed, false);
  assert.equal(rtc.mic.track.enabled, true);
  view.endVoice();

  // Hold to talk: a press when the app went away has ended.
  const held = await phoneVoice({ micMode: 'hold' });
  held.view.handleVoice('talk-start');
  assert.equal(rtc.mic.track.enabled, true);
  appLifecycle.markHidden();
  assert.equal(rtc.mic.track.enabled, false);
  appLifecycle.markVisible();
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(held.chat.voice.micOn, false);
  held.view.endVoice();
});

test('Mobile: back after more than 20 s (shortened here), the call is replaced, "Reconnecting…", with the chat as it is now and the mute kept', async () => {
  const { view, chat, plugin, log, first } = await phoneVoice();
  view.handleVoice('mute');
  appLifecycle.markHidden();
  plugin.chatHistory.push({ type: 'assistant', text: 'Finished while away' });
  await sleep(60);
  appLifecycle.markVisible();
  await until(() => rtc.pcs.length === 2 && pc().channel?.readyState === 'open');
  assert.equal(chat.voice.status, 'reconnecting');
  assert.deepEqual(first.channel.sent.at(-1), { type: 'session.close' });
  await until(() => first.closed);
  channel().receive({ type: 'session.started', session: { id: 'live_2' } });
  await until(() => chat.voice?.status === 'listening');
  const seeded = JSON.parse(log.live[1].body).session.input.map((item) => item.content[0].text);
  assert.ok(seeded.includes('Finished while away'));
  assert.equal(chat.voice.micOn, false);
  assert.equal(rtc.mic.track.enabled, false);
  assert.deepEqual(errorsShown(chat), []);
  view.endVoice();
});

test('Mobile: a call lost in the background shows no error and is replaced on the return', async () => {
  const { view, chat, first } = await phoneVoice();
  appLifecycle.markHidden();
  first.connectionState = 'failed';
  first.onconnectionstatechange();
  await sleep(5);
  assert.deepEqual(errorsShown(chat), []);
  assert.notEqual(chat.voice, null);
  appLifecycle.markVisible();
  await until(() => rtc.pcs.length === 2 && pc().channel?.readyState === 'open');
  assert.equal(chat.voice.status, 'reconnecting');
  channel().receive({ type: 'session.started', session: { id: 'live_2' } });
  await until(() => chat.voice?.status === 'listening');
  assert.deepEqual(errorsShown(chat), []);
  view.endVoice();
});

test('Mobile: after 60 s (shortened here) in the background the call ends quietly, also while JavaScript still runs', async () => {
  const { chat, first } = await phoneVoice();
  appLifecycle.markHidden();
  await until(() => chat.voice === null, 1000);
  assert.deepEqual(first.channel.sent.at(-1), { type: 'session.close' });
  await until(() => first.closed);
  appLifecycle.markVisible();
  await sleep(20);
  assert.equal(rtc.pcs.length, 1);
  assert.equal(chat.voice, null);
  assert.deepEqual(errorsShown(chat), []);
});

test('Desktop: a minimised window keeps the call and its microphone', async () => {
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  pc().connectionState = 'connected';
  appLifecycle.markHidden();
  assert.equal(rtc.mic.track.enabled, true);
  await sleep(200);
  appLifecycle.markVisible();
  assert.equal(rtc.pcs.length, 1);
  assert.equal(pc().closed, false);
  assert.equal(chat.voice.status, 'listening');
  view.endVoice();
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

test('Codex sign-in survives the trip to the browser: no polling in the background, network errors are retried', async () => {
  const { app } = secretApp();
  const auth = new X.CodexVoiceAuth(app);
  const polls = [];
  let failures = 2;
  globalThis.__providerRequest = async (request) => {
    if (request.url.endsWith('/deviceauth/token')) {
      polls.push(appLifecycle.isHidden());
      // Like a phone resolving no host for a moment.
      if (failures-- > 0) throw new Error('Request failed. UnknownHostException: Unable to resolve host "auth.openai.com"');
      return { status: 200, json: { authorization_code: 'code_1', code_verifier: 'verifier_1' } };
    }
    if (request.url === 'https://auth.openai.com/oauth/token') return { status: 200, json: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: 'refresh_1', id_token: jwt(authClaims), expires_in: 3600 } };
    throw new Error(`Unexpected ${request.url}`);
  };
  const code = { deviceAuthId: 'dev_1', userCode: 'ABCD-1234', verificationUrl: 'x', intervalMs: 0 };

  appLifecycle.markHidden();
  const signingIn = auth.completeDeviceSignIn(code);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(polls.length, 0);
  appLifecycle.markVisible();
  const credential = await signingIn;
  assert.deepEqual(polls, [false, false, false]);
  assert.equal(credential.accountId, 'acct_1');
});

test('Codex sign-in: no connection while getting the code says so', async () => {
  const { app } = secretApp();
  const auth = new X.CodexVoiceAuth(app);
  globalThis.__providerRequest = async () => { throw new Error('UnknownHostException'); };
  await assert.rejects(auth.startDeviceSignIn(), /No connection to auth\.openai\.com.*Check the internet connection/);
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

test('A Codex refresh that ends after sign-out stores nothing', async () => {
  const { app, secrets } = secretApp();
  secrets[CODEX_KEY] = JSON.stringify({ accessToken: 'old', refreshToken: 'refresh_1', accountId: 'acct_1', expiresAt: Date.now() + 60_000 });
  const auth = new X.CodexVoiceAuth(app);
  let answer;
  globalThis.__providerRequest = () => new Promise((resolve) => { answer = resolve; });
  const refreshing = auth.usableCredential();
  while (!answer) await new Promise((resolve) => setTimeout(resolve, 1));
  auth.signOut();
  answer({ status: 200, json: { access_token: 'late', refresh_token: 'refresh_2', expires_in: 3600 } });
  await assert.rejects(refreshing, /changed while the token was refreshed/);
  assert.equal(auth.getCredential(), null);
});
