# TD-012: No Obsidian lint rules or automated releases

The repo can't check the plugin guidelines before submission, and releases
are built on a developer machine.

- **Where:** `package.json`, `.github/workflows/`, `scripts/release.sh`
- **Impact:** medium for publishing; no effect on users

## Problem

- CI (`check.yml`) runs tests, type checks, Svelte checks and a build,
  but no ESLint.
- Upstream fixed its directory review comments by hand.
- `scripts/release.sh` builds and uploads releases locally.

## Fix

- Add ESLint with `eslint-plugin-obsidianmd` (`recommended`) and run it in CI.
- Add a tag-triggered release workflow that:
  - runs lint and checks
  - verifies the tag matches the `manifest.json` version
  - builds and attests `main.js`, `manifest.json` and `styles.css`
  - creates a draft GitHub release
- Reference implementation: `eslint.config.mjs` and
  `.github/workflows/release.yml` in
  [nagisa525/obsidian-chatting-plus](https://github.com/nagisa525/obsidian-chatting-plus).
