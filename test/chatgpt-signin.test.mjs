// ChatGPT provider on OpenAI's official "Sign in with ChatGPT" route (ADR-13):
// sign-in with a pasted callback address, token refresh and sign-out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { api, settings } from './harness.mjs';

const { auth } = api;
const ISSUED = 'oaiapp_test123';

function secretApp() {
  const secrets = new Map();
  return { secrets, secretStorage: { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) } };
}
function service() {
  const app = secretApp();
  const store = new api.ChatGPTOAuthStore(app);
  return { app, store, oauth: new auth.ChatGPTOAuthService(store) };
}
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = claims => `${b64({ alg: 'RS256' })}.${b64(claims)}.fake-signature`;
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
  globalThis.__providerRequest = async r => { request = r; return tokenResponse ? tokenResponse(pending) : tokens(pending.nonce); };
  await oauth.completeSignIn(callbackFor(pending, { code: 'fake-code', state: pending.state, client_id: ISSUED, scope: 'openid' }));
  return { pending, request };
}

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
  // A new attempt gets fresh values but keeps this device's host ID.
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
  await assert.rejects(oauth.completeSignIn('http://127.0.0.1:50000/auth/callback?code=c&state=s'), /Open the sign-in page first/);
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
  await signIn(oauth);
  globalThis.__providerRequest = async () => ({ status: 500 });
  assert.equal(await oauth.signOut(), false);
  assert.equal(oauth.getCredential(), null);
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

test('A credential from the former Codex sign-in counts as not connected', () => {
  const { app, oauth } = service();
  app.secrets.set('chatting-with-ai-minus-chatgpt-oauth', JSON.stringify({ accessToken: 'old', refreshToken: 'old', expiresAt: Date.now() + 1e6, updatedAt: 1, accountId: 'acct' }));
  assert.equal(oauth.getCredential(), null);
});
