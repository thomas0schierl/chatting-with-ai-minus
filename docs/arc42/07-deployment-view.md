# 7. Deployment view

> **Belongs here:** how the plugin is built, released and installed, and
> what lives where at runtime. **Elsewhere:** the build and test commands
> developers type (→ [AGENTS.md](../../AGENTS.md)).

## Build and release

1. `npm run build` bundles `src/` (TypeScript and Svelte) with esbuild into
   `main.js`. The Check workflow (`.github/workflows/check.yml`) runs lint,
   tests, type and Svelte checks and the build on every pull request and
   push to `main`. Lint fails on any warning. Workflows pin each action to
   a commit SHA; Dependabot (`.github/dependabot.yml`) opens weekly update
   PRs for the actions and npm packages.
2. A release is a GitHub release whose tag equals the `manifest.json`
   version, with three assets: `main.js`, `manifest.json`, `styles.css`.
3. `scripts/release.sh` bumps the version in `manifest.json`,
   `package.json` and `versions.json`, commits, tags and pushes.
4. The tag starts the Release workflow (`.github/workflows/release.yml`):
   - checks that the tag equals the `manifest.json` version and that
     `versions.json` lists it
   - runs lint, tests, type and Svelte checks, then builds
   - attests the three assets (build provenance, verifiable with
     `gh attestation verify`)
   - creates a draft GitHub release with them; a maintainer publishes it.
5. Obsidian's community plugin directory installs and updates from those
   releases. `versions.json` maps each plugin version to the minimum
   Obsidian version.

## Runtime locations

| What | Where | Synced across devices? |
|---|---|---|
| Plugin code | `<vault>/.obsidian/plugins/chatting-with-ai-minus/` (`main.js`, `manifest.json`, `styles.css`) | Depends on the user's sync setup |
| Settings and model lists | `data.json` in the plugin folder | Depends on the user's sync setup |
| Chat history | `chat-state.json` in the plugin folder | Not by Obsidian Sync by default |
| Debug log (when enabled) | `debug.log` in the plugin folder | No |
| API keys, ChatGPT tokens | OS keychain via Obsidian `SecretStorage` | No |

The same bundle runs on desktop (Electron) and mobile (iOS, Android);
nothing is platform-specific at build time.
