---
name: figma-design
description: "Figma design-to-code: design token extraction, component inspection and asset export. Use when implementing a Figma design, extracting its tokens, or checking a component's spec."
---

# Figma Design

Project design system: the **frontend-design** skill. Docs: https://developers.figma.com/docs/figma-mcp-server/

## MCP tools

Figma's own remote server (`https://mcp.figma.com/mcp`), signed in with OAuth. It works from a **link**: pass the Figma URL of the frame or layer, including its `node-id`. It does not see what is selected in the desktop app — that is the desktop server's feature.

| Tool | Use it for |
|------|---------|
| `figma/get_metadata` | A sparse outline of a large frame — layer IDs, names, positions, sizes. Start here on anything big, then narrow |
| `figma/get_design_context` | Design context for one layer: structure, styles, layout, as a starting point for code |
| `figma/get_variable_defs` | The variables and styles a layer uses — colors, spacing, typography — for token mapping |
| `figma/get_screenshot` | A PNG of the layer, to compare against what you built |
| `figma/search_design_system` | Components, variables and styles in the team's libraries — reuse before rebuilding |
| `figma/get_code_connect_map` | Which code component a Figma component already maps to |
| `figma/download_assets` | Image and vector exports |

On a large frame, get the outline with `get_metadata` first, then ask `get_design_context` for the frames you need.

## Workflow

1. `get_metadata` on the frame's link; pick the node IDs you need.
2. `get_design_context` and `get_variable_defs` for those nodes. Check `get_code_connect_map` and `search_design_system` first — a mapped component is imported, not rebuilt.
3. Map variables into the token files (`src/styles/tokens.css` or token JSON). Do not inline raw hex values into components; the returned code is a starting point, not the answer — translate it into the project's components and tokens.
4. Build the component with a `data-testid` so the result can be verified programmatically.
5. Verify with `get_screenshot` side by side, and compare DOM bounding boxes against the node metrics. **Acceptance: spacing within 4px, token colors exact, font family and weight exact.**
6. Outside threshold → fix the token mapping or ask design; re-run from step 2.

## Figma → CSS, the non-obvious mappings

| Figma | CSS |
|-------|-----|
| Hug contents | `width: fit-content` |
| Fill container | `flex: 1` (or `width: 100%`) |
| Fixed | `width: Npx` |
| Auto Layout gap | `gap` (not margins) |
| Drop shadow | `box-shadow: x y blur spread color` |

Auto Layout horizontal/vertical is just `flex-direction: row`/`column`.
