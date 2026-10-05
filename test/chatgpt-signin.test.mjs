// ChatGPT provider on OpenAI's official "Sign in with ChatGPT" route (ADR-13):
// sign-in with a pasted callback address, token refresh and sign-out,
// inference and model list on api.openai.com.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { api, settings, text, call, result, response, sse, transport } from './harness.mjs';

const { auth } = api;
const ISSUED = 'oaiapp_test123';
const PENDING_KEY = 'chatting-with-ai-minus-chatgpt-sign-in';
const OAUTH_KEY = 'chatting-with-ai-minus-chatgpt-oauth';

function secretApp() {
  const secrets = new Map();
  return { secrets, secretStorage: { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) } };
}
function service(app = secretApp()) {
  const store = new api.ChatGPTOAuthStore(app);
  return { app, store, oauth: new auth.ChatGPTOAuthService(store) };
}
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
// OpenAI's signing key, played by a test RSA key served as JWKS.
const rsaKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = rsaKey();
const KID = 'test-kid';
const jwk = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const sign = (input, privateKey) => createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
const jwt = (claims, { pair = signer, kid = KID, alg = 'RS256' } = {}) => {
  const input = `${b64({ alg, kid, typ: 'JWT' })}.${b64(claims)}`;
  return `${input}.${sign(input, pair.privateKey)}`;
};
/** Served at jwks_uri; tests may change it. */
let jwks;
let jwksRequests;
/** Answers discovery and JWKS like auth.openai.com; everything else goes to `handler`. */
const oauthServer = handler => async request => {
  if (request.url === 'https://auth.openai.com/.well-known/openid-configuration') {
    return { status: 200, json: { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' } };
  }
  if (request.url === 'https://auth.openai.com/.well-known/jwks.json') {
    jwksRequests++;
    return { status: 200, json: jwks };
  }
  return handler(request);
};
const idToken = (nonce, extra = {}) => jwt({ iss: 'https://auth.openai.com', aud: ISSUED, exp: Math.floor(Date.now() / 1000) + 3600, nonce, sub: 'user-sub', email: 'user@example.com', ...extra });
const callbackFor = (pending, params) => `${pending.redirectUri}?${new URLSearchParams(params)}`;
const tokens = (nonce, extra = {}) => ({ status: 200, json: {
  access_token: 'fake-access', refresh_token: 'fake-refresh', id_token: idToken(nonce), token_type: 'Bearer', expires_in: 3600,
  scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke', ...extra,
} });
function form(request) {
  return Object.fromEntries(new URLSearchParams(request.body));
}
/** Run a full sign-in; returns the token request. */
async function signIn(oauth, tokenResponse) {
  const pending = oauth.beginSignIn();
  let request;
  globalThis.__providerRequest = oauthServer(async r => { request = r; return tokenResponse ? tokenResponse(pending) : tokens(pending.nonce); });
  await oauth.completeSignIn(callbackFor(pending, { code: 'fake-code', state: pending.state, client_id: ISSUED, scope: 'openid' }));
  return { pending, request };
}

beforeEach(() => {
  jwks = { keys: [jwk(signer, KID)] };
  jwksRequests = 0;
  for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) api.clearCatalogModels(provider);
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

test('PKCE S256 challenge matches RFC 7636 for a known verifier', () => {
  assert.equal(auth.codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('First sign-in: authorize URL registers a new client with a persisted host ID', () => {
  const { app, oauth } = service();
  const pending = oauth.beginSignIn();
  const url = new URL(pending.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://auth.openai.com/api/accounts/authorize');
  const p = url.searchParams;
  assert.equal(p.get('client_id'), 'dynamic_agent_client');
  assert.equal(p.get('agent_name_hint'), 'Chatting with AI Minus');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(p.get('resource'), 'https://api.openai.com/v1');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('code_challenge'), createHash('sha256').update(pending.codeVerifier).digest('base64url'));
  assert.equal(p.get('state'), pending.state);
  assert.equal(p.get('nonce'), pending.nonce);
  assert.equal(p.get('redirect_uri'), pending.redirectUri);
  assert.equal(p.get('login_hint'), null);
  const port = Number(pending.redirectUri.match(/^http:\/\/127\.0\.0\.1:(\d+)\/auth\/callback$/)?.[1]);
  assert.ok(port >= 49152 && port <= 65535);
  assert.match(p.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Reopening the dialog within 10 minutes keeps the same attempt, so an
  // address copied after an accidental close still matches.
  assert.equal(oauth.beginSignIn(), pending);
  // An older attempt is replaced: fresh values, same host ID.
  pending.createdAt -= 11 * 60 * 1000;
  const again = oauth.beginSignIn();
  assert.notEqual(again.state, pending.state);
  assert.notEqual(again.nonce, pending.nonce);
  assert.notEqual(again.codeVerifier, pending.codeVerifier);
  assert.equal(new URL(again.url).searchParams.get('ext_agent_host_id'), p.get('ext_agent_host_id'));
  assert.ok([...app.secrets.keys()].every(key => /^[a-z0-9-]+$/.test(key)));
});

test('Callback parsing: valid, state mismatch, missing code, declined, bare code, wrong address', () => {
  const pending = { state: 's1', redirectUri: 'http://127.0.0.1:50000/auth/callback', clientId: 'dynamic_agent_client' };
  assert.deepEqual(auth.parseCallback(` ${callbackFor(pending, { code: 'c', state: 's1', client_id: ISSUED })} `, pending), { code: 'c', clientId: ISSUED });
  assert.throws(() => auth.parseCallback(callbackFor(pending, { code: 'c', state: 'other', client_id: ISSUED }), pending), /another sign-in attempt/);
  assert.throws(() => auth.parseCallback(callbackFor(pending, { state: 's1', client_id: ISSUED }), pending), /no sign-in code/);
  assert.throws(() => auth.parseCallback(callbackFor(pending, { error: 'access_denied', state: 's1' }), pending), /declined/);
  // State is checked before the error is trusted.
  assert.throws(() => auth.parseCallback(callbackFor(pending, { error: 'access_denied', state: 'x' }), pending), /another sign-in attempt/);
  assert.throws(() => auth.parseCallback('fake-code', pending), /whole address/);
  assert.throws(() => auth.parseCallback('http://127.0.0.1:50001/auth/callback?code=c&state=s1', pending), /isn't the address/);
  assert.throws(() => auth.parseCallback('http://localhost:50000/auth/callback?code=c&state=s1', pending), /isn't the address/);
  assert.throws(() => auth.parseCallback(callbackFor(pending, { code: 'c', state: 's1' }), pending), /no client ID/);
  const returning = { ...pending, clientId: ISSUED };
  assert.deepEqual(auth.parseCallback(callbackFor(returning, { code: 'c', state: 's1' }), returning), { code: 'c', clientId: ISSUED });
  assert.throws(() => auth.parseCallback(callbackFor(returning, { code: 'c', state: 's1', client_id: 'oaiapp_other' }), returning), /another app registration/);
});

test('Token exchange: request shape, stored credential, issued client ID saved and reused', async () => {
  const { app, store, oauth } = service();
  const { pending, request } = await signIn(oauth);
  assert.equal(request.url, 'https://auth.openai.com/api/accounts/oauth/token');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form(request), { grant_type: 'authorization_code', client_id: ISSUED, code: 'fake-code',
    code_verifier: pending.codeVerifier, redirect_uri: pending.redirectUri, resource: 'https://api.openai.com/v1' });
  const credential = oauth.getCredential();
  assert.equal(credential.accessToken, 'fake-access');
  assert.equal(credential.refreshToken, 'fake-refresh');
  assert.equal(credential.accountId, 'user-sub');
  assert.equal(credential.email, 'user@example.com');
  assert.ok(credential.scopes.includes('chatgpt.tokens.use.direct'));
  assert.equal(store.getRegistration().clientId, ISSUED);
  // A later sign-in reuses the issued client: no name hint, email as login hint.
  const next = new URL(oauth.beginSignIn().url).searchParams;
  assert.equal(next.get('client_id'), ISSUED);
  assert.equal(next.get('agent_name_hint'), null);
  assert.equal(next.get('login_hint'), 'user@example.com');
  assert.equal(next.get('ext_agent_host_id'), store.getRegistration().hostId);
  assert.ok(!app.secrets.get('chatting-with-ai-minus-chatgpt-registration').includes('fake-access'));
});

test('Sign-in is refused without the plan scope, with a wrong nonce, or with a rejected code', async () => {
  let { store, oauth } = service();
  await assert.rejects(signIn(oauth, pending => tokens(pending.nonce, { scope: 'openid profile email' })), /wasn't allowed/);
  assert.equal(oauth.getCredential(), null);
  // The registration was created at OpenAI; keep its client ID for the retry.
  assert.equal(store.getRegistration().clientId, ISSUED);
  ({ oauth } = service());
  await assert.rejects(signIn(oauth, () => tokens('other-nonce')), /doesn't match/);
  ({ oauth } = service());
  await assert.rejects(signIn(oauth, pending => tokens(pending.nonce, { id_token: idToken(pending.nonce, { aud: 'oaiapp_other' }) })), /another client/);
  ({ oauth } = service());
  await assert.rejects(signIn(oauth, () => ({ status: 400, json: { error: 'invalid_grant' } })), /rejected or has expired/);
  // The code is single-use: the attempt is over.
  await assert.rejects(oauth.completeSignIn('http://127.0.0.1:50000/auth/callback?code=c&state=s'), /No sign-in is waiting/);
});

test('RS256 check matches node:crypto, refuses tampering and short keys', () => {
  const key = jwk(signer, KID);
  const signature = new Uint8Array(Buffer.from(sign('header.payload', signer.privateKey), 'base64url'));
  assert.equal(auth.verifyRs256('header.payload', signature, key), true);
  assert.equal(auth.verifyRs256('header.payloaX', signature, key), false);
  const flipped = signature.slice();
  flipped[100] ^= 1;
  assert.equal(auth.verifyRs256('header.payload', flipped, key), false);
  assert.equal(auth.verifyRs256('header.payload', signature, jwk(rsaKey(), KID)), false);
  assert.equal(auth.verifyRs256('header.payload', signature, { ...key, alg: 'RS512' }), false);
  const short = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.equal(auth.verifyRs256('m', new Uint8Array(Buffer.from(sign('m', short.privateKey), 'base64url')), jwk(short, 'short')), false);
});

test('ID token signature: forged, unsigned or HMAC tokens are refused', async () => {
  const forged = rsaKey();
  for (const [options, message] of [[{ pair: forged }, /signature is invalid/], [{ alg: 'HS256' }, /no valid ID token/], [{ alg: 'none' }, /no valid ID token/]]) {
    const { oauth } = service();
    await assert.rejects(signIn(oauth, pending => tokens(pending.nonce, { id_token: jwt({ iss: 'https://auth.openai.com', aud: ISSUED,
      exp: Math.floor(Date.now() / 1000) + 3600, nonce: pending.nonce, sub: 'user-sub' }, options) })), message);
    assert.equal(oauth.getCredential(), null);
  }
});

test('Signing keys: cached, refetched once for an unknown key ID, fail closed when unreachable', async () => {
  const { oauth } = service();
  await signIn(oauth);
  await signIn(oauth);
  assert.equal(jwksRequests, 1);
  // OpenAI rotates its key: the new key ID triggers one refetch.
  const rotated = rsaKey();
  jwks = { keys: [jwk(signer, KID), jwk(rotated, 'rotated')] };
  const withKey = (pair, kid) => pending => tokens(pending.nonce, { id_token: jwt({ iss: 'https://auth.openai.com', aud: ISSUED,
    exp: Math.floor(Date.now() / 1000) + 3600, nonce: pending.nonce, sub: 'user-sub' }, { pair, kid }) });
  await signIn(oauth, withKey(rotated, 'rotated'));
  assert.equal(jwksRequests, 2);
  await assert.rejects(signIn(oauth, withKey(rsaKey(), 'unknown')), /key OpenAI doesn't publish/);
  assert.equal(jwksRequests, 3);

  // Keys unreachable: refused before the code is spent, so the same
  // address works once the network is back.
  const fresh = service().oauth;
  const pending = fresh.beginSignIn();
  const address = callbackFor(pending, { code: 'fake-code', state: pending.state, client_id: ISSUED });
  let tokenRequests = 0;
  globalThis.__providerRequest = async () => { throw new Error('offline'); };
  await assert.rejects(fresh.completeSignIn(address), /Couldn't load OpenAI's keys/);
  globalThis.__providerRequest = oauthServer(async () => ({ status: 200, json: { keys: 'none' } }));
  jwks = { nope: true };
  await assert.rejects(fresh.completeSignIn(address), /Couldn't load OpenAI's keys/);
  jwks = { keys: [jwk(signer, KID)] };
  globalThis.__providerRequest = oauthServer(async () => { tokenRequests++; return tokens(pending.nonce); });
  await fresh.completeSignIn(address);
  assert.equal(tokenRequests, 1);
  assert.ok(fresh.getCredential());
});

test('Refresh: issued client and resource, rotated tokens, one request at a time', async () => {
  const { store, oauth } = service();
  await signIn(oauth);
  store.set({ ...oauth.getCredential(), expiresAt: Date.now() - 1 });
  const requests = [];
  globalThis.__providerRequest = async request => {
    requests.push(request);
    return { status: 200, json: { access_token: 'fake-access-2', refresh_token: 'fake-refresh-2', expires_in: 3600, scope: 'chatgpt.tokens.use.direct openid' } };
  };
  const [a, b] = await Promise.all([oauth.getUsableCredential(), oauth.getUsableCredential()]);
  assert.equal(requests.length, 1);
  assert.equal(a, b);
  assert.deepEqual(form(requests[0]), { grant_type: 'refresh_token', client_id: ISSUED, refresh_token: 'fake-refresh', resource: 'https://api.openai.com/v1' });
  const stored = oauth.getCredential();
  assert.equal(stored.accessToken, 'fake-access-2');
  assert.equal(stored.refreshToken, 'fake-refresh-2');
  assert.equal(stored.accountId, 'user-sub');
  assert.ok(stored.expiresAt > Date.now());
});

test('Refresh failures: unusable token clears the sign-in, a server error keeps it', async () => {
  const { store, oauth } = service();
  await signIn(oauth);
  store.set({ ...oauth.getCredential(), expiresAt: Date.now() - 1 });
  globalThis.__providerRequest = async () => ({ status: 503, text: 'unavailable' });
  await assert.rejects(oauth.getUsableCredential(), /refresh failed/);
  assert.ok(oauth.getCredential());
  globalThis.__providerRequest = async () => ({ status: 400, json: { error: 'invalid_grant' } });
  await assert.rejects(oauth.getUsableCredential(), /expired/);
  assert.equal(oauth.getCredential(), null);
  assert.equal(store.getRegistration().clientId, ISSUED);
});

test('Sign-out revokes the refresh token and keeps the registration', async () => {
  const { store, oauth } = service();
  await signIn(oauth);
  let request;
  globalThis.__providerRequest = async r => { request = r; return { status: 200, text: '' }; };
  assert.equal(await oauth.signOut(), true);
  assert.equal(request.url, 'https://auth.openai.com/api/accounts/oauth/revoke');
  assert.deepEqual(form(request), { token: 'fake-refresh', token_type_hint: 'refresh_token', client_id: ISSUED });
  assert.equal(oauth.getCredential(), null);
  assert.equal(store.getRegistration().clientId, ISSUED);
});

test('Revocation is retried once after a network error or 5xx, not after a 4xx', async (t) => {
  const { oauth } = service();
  // The retry waits on window.setTimeout; skip the wait here.
  globalThis.window = { setTimeout: fn => setTimeout(fn, 0) };
  t.after(() => { delete globalThis.window; });
  const revokeWith = async (...results) => {
    await signIn(oauth);
    let calls = 0;
    globalThis.__providerRequest = async () => {
      const next = results[calls++];
      if (next instanceof Error) throw next;
      return next;
    };
    const revoked = await oauth.signOut();
    assert.equal(oauth.getCredential(), null);
    return { revoked, calls };
  };
  assert.deepEqual(await revokeWith({ status: 503 }, { status: 200, text: '' }), { revoked: true, calls: 2 });
  assert.deepEqual(await revokeWith(new Error('offline'), { status: 200, text: '' }), { revoked: true, calls: 2 });
  assert.deepEqual(await revokeWith({ status: 500 }, { status: 502 }), { revoked: false, calls: 2 });
  assert.deepEqual(await revokeWith({ status: 400, json: { error: 'invalid_client' } }), { revoked: false, calls: 1 });
});

test('The pending attempt survives a restart until it is used or 10 minutes old', async () => {
  const app = secretApp();
  const first = service(app).oauth.beginSignIn();
  assert.ok(app.secrets.get(PENDING_KEY).includes(first.codeVerifier));
  // A new service (Obsidian restarted) reopens the same attempt...
  assert.deepEqual(service(app).oauth.beginSignIn(), first);
  // ...and completes the pasted address with its verifier.
  const { oauth } = service(app);
  let request;
  globalThis.__providerRequest = oauthServer(async r => { request = r; return tokens(first.nonce); });
  await oauth.completeSignIn(callbackFor(first, { code: 'fake-code', state: first.state, client_id: ISSUED }));
  assert.equal(form(request).code_verifier, first.codeVerifier);
  assert.equal(form(request).redirect_uri, first.redirectUri);
  assert.ok(oauth.getCredential());
  // Used: cleared from SecretStorage.
  assert.equal(app.secrets.get(PENDING_KEY), '');
  assert.equal(service(app).oauth.beginSignIn().state === first.state, false);

  // An attempt over 10 minutes old is dropped, also from SecretStorage.
  const old = { ...service(app).oauth.beginSignIn(), createdAt: Date.now() - 11 * 60 * 1000 };
  app.secrets.set(PENDING_KEY, JSON.stringify(old));
  await assert.rejects(service(app).oauth.completeSignIn(callbackFor(old, { code: 'c', state: old.state })), /No sign-in is waiting/);
  assert.equal(app.secrets.get(PENDING_KEY), '');
  // A malformed record counts as none.
  app.secrets.set(PENDING_KEY, '{"state":1}');
  assert.notEqual(service(app).oauth.beginSignIn().state, 1);
});

test('Inference: api.openai.com/v1/responses, bearer only, store false, stream true, namespaced tools', async () => {
  const requests = [];
  globalThis.__providerRequest = async request => { requests.push(request); return response('chatgpt-oauth', [text('OK')]); };
  const tools = [{ name: 'read_document', description: 'Read', inputSchema: { type: 'object', properties: {} } }];
  await api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Hi' }], tools, 'System');
  const [request] = requests;
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.method, 'POST');
  assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Authorization', 'Content-Type']);
  assert.equal(request.headers.Authorization, 'Bearer fake-token');
  const body = JSON.parse(request.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, 'System');
  assert.equal(body.previous_response_id, undefined);
  assert.ok(!body.input.some(item => item.role === 'system'));
  assert.deepEqual(body.tools.map(t => t.type), ['namespace', 'web_search']);
  assert.equal(body.tools[0].name, 'vault');
  assert.deepEqual(body.tools[0].tools.map(t => [t.type, t.name]), [['function', 'read_document']]);
});

test('Replayed function calls carry the tool namespace on the ChatGPT route only', () => {
  const history = [{ role: 'assistant', content: [call('a', 'read_document', {})] }, { role: 'user', content: [result('a', 'data')] }];
  assert.equal(api.buildResponsesInput(history, 'chatgpt-oauth')[0].namespace, 'vault');
  assert.equal(api.buildResponsesInput(history, 'openai')[0].namespace, undefined);
});

test('Errors: usage limit links to ChatGPT usage, 401 asks to sign in again', async () => {
  transport(() => sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached' } } }]));
  await assert.rejects(api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Hi' }], [], 'S'),
    /Limit reached \(subscription_sharing_usage_limit_exceeded\)\. Manage usage: https:\/\/chatgpt\.com\/settings\/usage/);
  transport(() => ({ status: 401, json: { detail: 'Not accepted' } }));
  await assert.rejects(api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Hi' }], [], 'S'), /Not accepted\. Continue with ChatGPT/);
});

test('Model list: /v1/models with the bearer token, only visibility "list"', async () => {
  const requests = [];
  globalThis.__githubRequest = async () => ({ status: 200, json: { tag_name: 'rust-v0.161.0', prerelease: false, draft: false } });
  globalThis.__providerRequest = async request => {
    requests.push(request);
    return { status: 200, json: { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }, { slug: 'internal', visibility: 'hide' }] } };
  };
  const identity = await api.catalogIdentity('chatgpt-oauth', 'fake-account');
  const state = { entries: [] };
  const models = await api.refreshCatalog(state, 'chatgpt-oauth', identity, '', { getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) }, true);
  // The latest stable Codex release is sent as client_version (undocumented
  // gating) and cached in the catalog state.
  assert.equal(requests[0].url, 'https://api.openai.com/v1/models?client_version=0.161.0');
  assert.equal(state.clientVersion.value, '0.161.0');
  delete globalThis.__githubRequest;
  assert.deepEqual(requests[0].headers, { Authorization: 'Bearer fake-token' });
  assert.deepEqual(models, [{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: undefined, defaultReasoningEffort: undefined, supportsReasoningSummary: undefined, supportsParallelTools: undefined }]);
});

test('No sign-in secrets or IDs reach data.json', async () => {
  const { app, oauth } = service();
  await signIn(oauth);
  const credential = oauth.getCredential();
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.chatgptOAuth = oauth;
  plugin.getChatView = () => null;
  let saved;
  plugin.saveData = async data => { saved = JSON.stringify(data); };
  plugin.settings = { ...settings('chatgpt-oauth'), apiKey: '', modelCatalog: { entries: [{ provider: 'chatgpt-oauth',
    identity: await api.catalogIdentity('chatgpt-oauth', credential.accountId), fetchedAt: Date.now(), models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] }] } };
  await plugin.saveSettings();
  const registration = JSON.parse(app.secrets.get('chatting-with-ai-minus-chatgpt-registration'));
  for (const value of [credential.accessToken, credential.refreshToken, credential.idToken, credential.email, credential.accountId, registration.hostId, ISSUED]) {
    assert.ok(!saved.includes(value), `data.json must not contain ${value}`);
  }
});

test('A credential from the former Codex sign-in is erased on first read', () => {
  const { app, oauth } = service();
  app.secrets.set(OAUTH_KEY, JSON.stringify({ accessToken: 'old', refreshToken: 'old', expiresAt: Date.now() + 1e6, updatedAt: 1, accountId: 'acct' }));
  assert.equal(oauth.getCredential(), null);
  assert.equal(app.secrets.get(OAUTH_KEY), '');
});
