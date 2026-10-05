// The public build leaves the unofficial Codex voice route out (ADR-14);
// the private build has it. Runs the real build config into a temp folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CODEX_MARKERS = ['app_EMoamEEZ73f0CkXaXp7hrann', 'backend-api/codex/realtime', 'Sign in as Codex', 'gpt-live-1-codex'];

function build(...args) {
  const dir = mkdtempSync(join(tmpdir(), 'minus-build-'));
  const outfile = join(dir, 'main.js');
  try {
    const result = spawnSync(process.execPath, ['esbuild.config.mjs', 'production', ...args], { env: { ...process.env, OUTFILE: outfile }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(outfile, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('The public build has no Codex voice code; the private build has it', () => {
  const publicBuild = build();
  for (const marker of CODEX_MARKERS) assert.ok(!publicBuild.includes(marker), `public build contains ${marker}`);
  assert.ok(publicBuild.includes('/live/sessions'), 'public build has the official voice route');

  const privateBuild = build('private');
  for (const marker of CODEX_MARKERS) assert.ok(privateBuild.includes(marker), `private build lacks ${marker}`);
});
