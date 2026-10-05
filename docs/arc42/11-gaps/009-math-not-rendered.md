# GAP-009: Math in answers isn't rendered

LaTeX that models write as `\(...\)`, `\[...\]` or ` ```math ` blocks shows
up as raw text.

- **Where:** answer rendering in `src/ui/ChatContainer.svelte` (`MarkdownRenderer`)
- **Impact:** low to medium; affects maths and science answers

## Problem

Obsidian renders only `$...$` and `$$...$$`.

## Fix

- At render time only, convert `\(...\)`, `\[...\]` and fenced
  `math`/`latex`/`tex` blocks to `$`/`$$`.
- Leave inline and fenced code untouched, so LaTeX examples inside code
  aren't changed. The stored message stays unchanged.
- Reference implementation: `src/ui/math-markdown.ts` in
  [nagisa525/obsidian-chatting-plus](https://github.com/nagisa525/obsidian-chatting-plus).
