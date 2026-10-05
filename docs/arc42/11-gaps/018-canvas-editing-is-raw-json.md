# GAP-018: Canvas editing is raw JSON editing, and canvases aren't searchable

The agent can only change a canvas by find/replace on its JSON text, and
`search_vault` never finds anything in canvases.

- **Where:** `tools/executor.ts`, `tools/registry.ts`
- **Impact:** medium for canvas users; medium effort

## Problem

- **Reading:** `read_file` returns the raw JSON Canvas file. It works, but
  is verbose, and positions are bare numbers.
- **Editing:**
  - Adding a card or an edge means `edit_document` string replacement
    inside JSON, which breaks easily (duplicate IDs, invalid JSON,
    overlapping cards).
  - `create_file` can write a whole canvas, but has no structure checks.
- **Search:** `search_vault` scans Markdown files only
  (`getMarkdownFiles()`), so text on canvas cards is never found.

## Fix

- **`read_canvas`:** a compact, readable view: groups, then the nodes in
  each, with ID, type, text or file, approximate position and size, then
  the edges ("A → B: label").
- **`edit_canvas`:** structured operations:
  - add, update or remove a node or an edge
  - move or resize a node
  - put a node in a group
  - It generates IDs, keeps the JSON valid, places new nodes next to a
    given node without overlap, and writes atomically with
    `vault.process()`.
- **`search_vault`:** also search the text of canvas cards (and edge
  labels), reporting the canvas path and node ID.
- **Seeing the result:** check results visually with `view_canvas`
  ([GAP-017](017-agent-cannot-see-images-or-canvases.md)).
- **Format:** follow the open JSON Canvas spec (jsoncanvas.org); keep
  unknown fields untouched.
