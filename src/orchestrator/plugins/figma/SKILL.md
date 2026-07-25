---
name: figma-design
description: "Figma design-to-code workflows, design token extraction, component inspection, and asset export. Use when translating Figma designs into code, extracting design tokens, or referencing component specs."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Figma Design

Project design system: the **frontend-design** skill. Docs: https://www.figma.com/developers/api

## MCP tools

| Tool | Purpose |
|------|---------|
| `figma/get_file` | Full file structure — takes `depth` to cap traversal |
| `figma/get_file_nodes` | Specific nodes/frames by `node_ids` |
| `figma/get_images` | Export nodes: `{ ids, format, scale }` |
| `figma/get_comments` | Design review comments |
| `figma/get_styles` | Color/text/effect styles |
| `figma/get_components` | Reusable components |

Every call needs `file_key` (from the file URL). Node IDs use a colon, e.g. `"123:45"`. Never call `get_file` without `depth` on a large file — it returns the entire node tree.

## Workflow

1. `get_file_nodes` for the target frames; extract bounding boxes, fills, text styles, and auto-layout properties.
2. Map returned styles into token files (`src/styles/tokens.css` or token JSON) — do not inline raw hex values into components.
3. Build the component consuming those tokens, with a `data-testid` so the result can be verified programmatically.
4. Verify: render in Storybook, compare DOM bounding boxes against the Figma node metrics. **Acceptance: spacing within 4px, token colors exact, font family and weight exact.**
5. Outside threshold → fix the token mapping or ask design; re-run from step 1.

## Figma → CSS, the non-obvious mappings

| Figma | CSS |
|-------|-----|
| Hug contents | `width: fit-content` |
| Fill container | `flex: 1` (or `width: 100%`) |
| Fixed | `width: Npx` |
| Auto Layout gap | `gap` (not margins) |
| Drop shadow | `box-shadow: x y blur spread color` |

Auto Layout horizontal/vertical is just `flex-direction: row`/`column`.
