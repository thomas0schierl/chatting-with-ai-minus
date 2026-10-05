/**
 * Build flag set by esbuild (`esbuild.config.mjs`): true only in private
 * builds, which include the unofficial Codex voice route (ADR-14). Code
 * behind `if (__CODEX_VOICE__)` is left out of public builds.
 */
declare const __CODEX_VOICE__: boolean;
