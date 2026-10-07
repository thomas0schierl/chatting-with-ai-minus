import esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { sveltePreprocess } from "svelte-preprocess";
import process from "process";
import { existsSync, renameSync } from "fs";
import { dirname, join } from "path";

const prod = process.argv[2] === "production";
// Tests build into a temporary file (test/voice-build.test.mjs).
const outfile = process.env.OUTFILE ?? "main.js";

/**
 * All CSS (src/styles.css, imported by main.ts, then each component's
 * scoped styles) goes into one file next to main.js. esbuild names it
 * after the bundle (main.css); Obsidian loads styles.css.
 */
const stylesCss = {
  name: "styles-css",
  setup(build) {
    build.onEnd((result) => {
      const css = outfile.replace(/\.js$/, ".css");
      if (!result.errors.length && existsSync(css)) renameSync(css, join(dirname(outfile), "styles.css"));
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [
    esbuildSvelte({
      compilerOptions: {
        // Component CSS goes into styles.css, not into <style> at runtime.
        css: "external",
        // Svelte's default style hash comes from the file name, so it would
        // equal Chatting with AI's, and each plugin's scoped rules would
        // also match the other's elements. Hash the plugin ID and the CSS.
        cssHash: ({ css, hash }) => `svelte-${hash(`chatting-with-ai-minus${css}`)}`,
      },
      preprocess: sveltePreprocess(),
    }),
    stylesCss,
  ],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  // Folds constant conditions; names and layout stay readable.
  minifySyntax: prod,
  treeShaking: true,
  outfile,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
