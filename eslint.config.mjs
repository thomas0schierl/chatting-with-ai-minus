// Obsidian's plugin review rules (eslint-plugin-obsidianmd, "recommended").
// Lints the TypeScript sources and package.json. The plugin has no Svelte
// support, so .svelte files are left to svelte-check. `npm run lint` fails on
// any warning too (--max-warnings 0).
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
// The rule's options replace its default lists, so extend them.
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

export default defineConfig([
  // Build output, local material and Node-only dev scripts (not shipped).
  globalIgnores(["main.js", "temp/", "esbuild.config.mjs", "scripts/", "test/"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      // Build flag set by esbuild (src/globals.d.ts).
      globals: { __CODEX_VOICE__: "readonly" },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: [...DEFAULT_BRANDS, "Chatting with AI Minus", "ChatGPT", "Codex", "OAuth"],
          acronyms: [...DEFAULT_ACRONYMS, "OS"],
          // Example URLs shown as text are not sentences.
          ignoreRegex: ["^https?://"],
        },
      ],
    },
  },
]);
