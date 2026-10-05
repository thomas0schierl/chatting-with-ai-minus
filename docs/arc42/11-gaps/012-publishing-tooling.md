# GAP-012: Obsidian lint findings don't fail CI yet

`npm run lint` runs Obsidian's review rules in CI and in the release
workflow, but the existing findings in `src/` only warn, so new ones of the
same kind can slip through.

- **Where:** `src/`, `eslint.config.mjs`
- **Impact:** medium for publishing (the directory review flags them); no
  effect on users

## Problem

- A temporary block in `eslint.config.mjs` turns four rules from error
  into warning: `@typescript-eslint/no-base-to-string`,
  `@typescript-eslint/no-unsafe-assignment`,
  `@typescript-eslint/no-unnecessary-type-assertion`, `obsidianmd/platform`.
- `npm run lint` reports warnings in:
  - `src/tools/canvas.ts`: canvas JSON fields stringified or assigned as
    `any`
  - `src/diagnostics/capability-check.ts`: `fetch` and `navigator`
  - `src/settings.ts`, `src/main.ts`: sentence case, deprecated
    `display()` and `setWarning()`
- Some need a decision, not just a fix. The plugin forbids disabling its
  rules in comments, so `fetch` in the capability check (ADR-12 probing)
  stays flagged while it exists. `display()` is required while
  `minAppVersion` is below 1.13.

## Fix

- Fix or remove the findings in `src/`.
- Delete the temporary block in `eslint.config.mjs` and run lint with
  `--max-warnings 0`, so any finding fails CI.
