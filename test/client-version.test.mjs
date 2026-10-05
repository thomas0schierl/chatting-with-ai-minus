// codexClientVersion(): the latest stable Codex CLI release, sent as the
// ChatGPT model list's client_version (and by the private Codex voice
// route). Its own file: the lookup keeps module state between calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const FALLBACK = '0.160.0';

function github(answer) {
  const requests = [];
  globalThis.__githubRequest = async (request) => {
    requests.push(request);
    return answer();
  };
  return requests;
}

test('codexClientVersion: cached for a day, one request at a time, only stable rust-v tags, fallback on failure', async () => {
  // A version checked within the day is used as it is.
  let requests = github(() => assert.fail('no request while the version is fresh'));
  assert.equal(await api.codexClientVersion({ entries: [], clientVersion: { value: '0.150.0', checkedAt: Date.now() } }, false), '0.150.0');

  // Otherwise GitHub's latest release; parallel calls share the request.
  requests = github(() => ({ status: 200, json: { tag_name: 'rust-v0.170.1', prerelease: false, draft: false } }));
  const state = { entries: [] };
  const [a, b] = await Promise.all([api.codexClientVersion(state, false), api.codexClientVersion(state, false)]);
  assert.deepEqual([a, b], ['0.170.1', '0.170.1']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.github.com/repos/openai/codex/releases/latest');
  assert.equal(state.clientVersion.value, '0.170.1');

  // A failed or unusable answer keeps the known version (or the fallback).
  for (const answer of [
    { status: 503, json: {} },
    { status: 200, json: { tag_name: 'rust-v0.171.0-alpha.1', prerelease: true } },
    { status: 200, json: { tag_name: 'rust-v0.172.0', prerelease: true, draft: false } },
    { status: 200, json: { tag_name: 'v0.172.0', prerelease: false, draft: false } },
  ]) {
    requests = github(() => answer);
    assert.equal(await api.codexClientVersion({ entries: [] }, true), FALLBACK, JSON.stringify(answer));
    const known = { entries: [], clientVersion: { value: '0.165.0', checkedAt: 0 } };
    assert.equal(await api.codexClientVersion(known, true), '0.165.0');
    assert.equal(known.clientVersion.checkedAt, 0);
  }

  // After an attempt, a stale version isn't looked up again for 5 minutes, unless forced.
  requests = github(() => ({ status: 200, json: { tag_name: 'rust-v0.180.0', prerelease: false, draft: false } }));
  assert.equal(await api.codexClientVersion({ entries: [], clientVersion: { value: '0.165.0', checkedAt: 0 } }, false), '0.165.0');
  assert.equal(requests.length, 0);
  assert.equal(await api.codexClientVersion({ entries: [] }, true), '0.180.0');
  assert.equal(requests.length, 1);
  delete globalThis.__githubRequest;
});
