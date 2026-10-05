// The public build leaves the unofficial Codex voice route out (ADR-14);
// the private build has it. Both write all CSS into styles.css. Runs the
// real build config into a temp folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CODEX_MARKERS = ['app_EMoamEEZ73f0CkXaXp7hrann', 'backend-api/codex/realtime', 'Sign in as Codex', 'gpt-live-1-codex'];

function build(...args) {
  const dir = mkdtempSync(join(tmpdir(), 'minus-build-'));
  const outfile = join(dir, 'main.js');
  try {
    const result = spawnSync(process.execPath, ['esbuild.config.mjs', 'production', ...args], { env: { ...process.env, OUTFILE: outfile }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'main.css')), false);
    return { js: readFileSync(outfile, 'utf8'), css: readFileSync(join(dir, 'styles.css'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The component's scoped classes carry a hash of the plugin ID and the CSS.
const SCOPED_INPUT_BAR = /\.chatting-minus-input-bar\.svelte-[a-z0-9]+\s*\{/;

test('The public build has no Codex voice code; the private build has it', () => {
  const publicBuild = build();
  for (const marker of CODEX_MARKERS) assert.ok(!publicBuild.js.includes(marker), `public build contains ${marker}`);
  assert.ok(publicBuild.js.includes('/live/sessions'), 'public build has the official voice route');

  const privateBuild = build('private');
  for (const marker of CODEX_MARKERS) assert.ok(privateBuild.js.includes(marker), `private build lacks ${marker}`);

  for (const { js, css } of [publicBuild, privateBuild]) {
    // Global styles first, then the component's; none injected at runtime.
    assert.ok(css.indexOf('.chatting-minus-view-container') < css.search(SCOPED_INPUT_BAR));
    assert.match(css, SCOPED_INPUT_BAR);
    assert.ok(!js.includes('max-height: 300px'), 'main.js carries CSS');
  }
});
