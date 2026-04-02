---
name: figma-design
description: "Figma design-to-code workflows, design token extraction, component inspection, and asset export. Use when translating Figma designs into code, extracting design tokens, or referencing component specs."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Figma Design

For project-specific design system details, see the **frontend-design** skill.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `figma/get_file` | Retrieve full Figma file structure |
| `figma/get_file_nodes` | Get specific nodes/frames |
| `figma/get_images` | Export nodes as images |
| `figma/get_comments` | Read design review comments |
| `figma/get_styles` | Extract color/text/effect styles |
| `figma/get_components` | List reusable components |

### Example MCP invocations

```json
// figma/get_file — full file structure
{ "file_key": "a1b2C3d4E5", "depth": 2 }
// figma/get_file_nodes — specific frames
{ "file_key": "a1b2C3d4E5", "node_ids": ["123:45"] }
// figma/get_images — export as PNG at 2x
{ "file_key": "a1b2C3d4E5", "ids": ["123:45"], "format": "png", "scale": 2 }
```

## Design-to-Code Workflow

1. **Identify the frame** — obtain the Figma file key or node ID from the task input.
2. **Inspect nodes** — call `figma/get_file_nodes` for the target node IDs and extract bounding boxes, fills, text styles, and auto-layout info.
3. **Extract tokens** — map returned styles to token files (colors, typography, spacing) and commit tokens to `src/styles/tokens.css` or a token JSON.
4. **Implement component** — scaffold a framework component that consumes tokens and matches layout properties (gap, padding, width). Import tokens (CSS variables or JSON) and attach a `data-testid` for programmatic verification.

```tsx
// src/components/ui/Card.tsx — consumes tokens, matches Figma layout
import '../styles/tokens.css';
interface CardProps { title: string; description?: string }
export function Card({ title, description }: CardProps) {
  return (
    <div data-testid="card" className="card">
      <span className="card-title">{title}</span>
      {description && <p>{description}</p>}
    </div>
  );
}
```
5. **Verify programmatically** — run a visual diff or DOM-attribute check:
  - Render in Storybook and compare DOM bounding boxes against Figma node metrics.
  - Acceptance: differences <= 4px for spacing and matching token colors; fonts must match family and weight.
6. **Feedback loop** — if implementation deviates beyond thresholds, update token mapping or request design clarification and repeat from step 2.

See REFERENCE.md for a verification script and Figma→CSS translation rules.

