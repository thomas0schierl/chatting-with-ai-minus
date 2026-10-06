# 7. Deployment view

> **Belongs here:** how the plugin is built, released and installed, and
> what lives where at runtime. **Elsewhere:** the build and test commands
> developers type (→ [AGENTS.md](../../AGENTS.md)).

## Build and release

1. `npm run build` bundles `src/` (TypeScript and Svelte) with esbuild into
   `main.js`, and all CSS into `styles.css` (generated, not in git):
   `src/styles.css` first, then the components' scoped styles. It is the public build: `__CODEX_VOICE__` is false and the
   private Codex voice route is left out (ADR-14). `npm run build:private`
   (and `npm run dev`) include it; such builds are never released. The Check workflow (`.github/workflows/check.yml`) runs lint,
   tests, type and Svelte checks and the build on every pull request and
   push to `main`. Lint fails on any warning. Workflows pin each action to
   a commit SHA; Dependabot (`.github/dependabot.yml`) opens weekly update
   PRs for the actions and npm packages.
2. A release is a GitHub release whose tag equals the `manifest.json`
   version, with three assets: `main.js`, `manifest.json`, `styles.css`.
3. `scripts/release.sh` bumps the version in `manifest.json`,
   `package.json`, `package-lock.json` and `versions.json`, commits, tags
   and pushes to the branch the current one tracks (the repository is
   [thomas0schierl/chatting-with-ai-minus](https://github.com/thomas0schierl/chatting-with-ai-minus),
   private for now, remote `origin`; the upstream is no remote, so
   nothing can be pushed there by mistake).
4. The tag starts the Release workflow (`.github/workflows/release.yml`):
   - checks that the tag equals the `manifest.json` version and that
     `versions.json` lists it
   - runs lint, tests, type and Svelte checks, then builds
   - attests the three assets (build provenance, verifiable with
     `gh attestation verify`), only while the repository is public:
     GitHub's plans offer attestations for private repositories only on
     Enterprise
   - creates a draft GitHub release with them; a maintainer publishes it.
5. Obsidian's community plugin directory installs and updates from those
   releases. `versions.json` maps each plugin version to the minimum
   Obsidian version.

## Runtime locations

| What | Where | Synced across devices? |
|---|---|---|
| Plugin code | `<vault>/.obsidian/plugins/chatting-with-ai-minus/` (`main.js`, `manifest.json`, `styles.css`) | Depends on the user's sync setup |
| Settings and model lists | `data.json` in the plugin folder | Depends on the user's sync setup |
| Chat history | `chat-state.json` in the plugin folder | Not by the plugin; treated as per device |
| Debug log (when enabled) | `debug.log` in the plugin folder | No |
| API keys, ChatGPT tokens | OS keychain via Obsidian `SecretStorage` | No |

The same bundle runs on desktop (Electron) and mobile (iOS, Android);
nothing is platform-specific at build time. Public and private builds
differ only in the Codex voice route.
