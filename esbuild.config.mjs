import esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { sveltePreprocess } from "svelte-preprocess";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [
    esbuildSvelte({
      compilerOptions: {
        css: "injected",
        // Svelte's default style hash comes from the file name, so it would
        // equal Chatting with AI's: the first plugin's styles win and ours
        // are never injected. Hash the plugin ID and the CSS instead.
        cssHash: ({ css, hash }) => `svelte-${hash(`chatting-with-ai-minus${css}`)}`,
      },
      preprocess: sveltePreprocess(),
    }),
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
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
