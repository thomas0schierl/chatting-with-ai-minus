# GAP-017: The agent can't look at images or canvases

The model can see images the user attaches, but not images or canvases in
the vault. It can't "take a picture" of a canvas to understand its layout.

- **Where:** `tools/executor.ts` (`read_file`), `tools/registry.ts`,
  `types.ts` (`ToolResult`), the adapters' tool-result encoding
- **Impact:** medium–high for visual notes and canvas users; medium effort

## Problem

- **Images:** `read_file` reads every file as text (`cachedRead`). An
  image comes back as its raw bytes as text: useless to the model and
  expensive in tokens.
- **No image results:** tool results are text only, so there's no way to
  hand the model an image.
- **Canvases:** a canvas can only be read as its JSON, where the layout is
  just coordinates. `read_canvas` gives a readable outline, but there's no
  way to see the layout.

## Fix

1. **Image tool results:** let a tool result carry images.
   - **Anthropic:** accepts image blocks inside a `tool_result`.
   - **OpenAI and Codex:** check whether `function_call_output` accepts
     images. If not, add the image in a user message right after the
     result, which every provider accepts.
2. **`view_image` tool:** reads an image file from the vault
   (`readBinary`), scales it down to the attachment limits, and returns it
   as an image. `read_file` refuses binary files with a hint to use
   `view_image`.
3. **`view_canvas` tool:** renders a `.canvas` file to a PNG and returns
   it, plus a short text legend (node IDs, so the model can refer to
   them). The renderer draws the JSON Canvas data itself on an HTML
   `<canvas>`:
   - groups as labelled boxes, cards with wrapped plain text
   - file nodes with their names; image files drawn as the image
   - links with their URL; edges with arrows and labels
   - the canvas colour presets

   This is plain DOM drawing, so it works the same on desktop and mobile.
   **Rejected:** screenshotting the open canvas view, which is
   desktop-only (Electron) and depends on what's on screen.
4. **Limits:**
   - Markdown inside cards is drawn as plain text.
   - Very large canvases are scaled to fit, with an optional `region` or
     group parameter to zoom in.
   - The image counts toward the provider's image limits and cost.
