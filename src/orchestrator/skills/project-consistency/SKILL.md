---
name: project-consistency
description: "Foundation-first pattern that keeps parallel UI work consistent: shared tokens, layout and UI components built before any page. Use when several agents build UI at once, or a design system or theme is being set up."
---

# Project Consistency

Produce shared artifacts and automated checks before parallel work begins.

## Foundation-First Principle

Phase 1 (sequential): `foundation-setup` creates tokens, Layout, UI library, style guide brief. Phase 2 (parallel): every page task imports from Phase 1 — no new tokens, no duplicated components.

### Foundation Artifacts & Page Rules

| Artifact | Path | Page Agent Rules |
|----------|------|------------------|
| **Design tokens** | `src/styles/tokens.css` | Import only. Never introduce new color/font/spacing values. |
| **Shared layout** | `src/components/Layout.tsx` / `Layout.astro` | Wrap every page. Never recreate. |
| **UI components** | `src/components/ui/` | Import from library. PascalCase components, camelCase props. |
| **Style guide brief** | Inline in prompts | Match tone + terminology exactly. Follow heading hierarchy. |

**Validation checkpoints:**
1. Foundation complete: `tokens.css` has all palette/type/spacing vars, Layout renders, UI components compile.
2. Per-page: `grep -rF 'style={{' src/pages/` returns 0 hits (no inline styles). All imports resolve.

---

## Convoy Integration

Include these 5 Foundation References in every page prompt:

```
1. Design tokens path   2. Layout path   3. UI components path
4. Aesthetic direction   5. Content tone
```

Prompt templates: see [TEMPLATES.md](./TEMPLATES.md).

---

## Example: `src/styles/tokens.css`

```css
:root {
	/* Palette */
	--color-bg: #ffffff;
	--color-foreground: #0f172a;
	--color-primary: #0ea5e9;
	--color-primary-600: #0284c7;

	/* Typography */
	--font-base: 'Source Sans 3', system-ui, sans-serif; /* the pairing chosen in frontend-design */
	--text-sm: 0.875rem;
	--text-base: 1rem;

	/* Spacing */
	--space-1: 4px;
	--space-2: 8px;
	--space-3: 16px;

	/* Radius */
	--radius-sm: 6px;
	--radius-md: 12px;
}
```

UI components consume these vars only — e.g. `bg-[var(--color-primary)]`, never a literal hex.

---

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Agents pick their own fonts/colors | Foundation creates tokens first |
| Copy-pasting `Button` between pages | Import from shared library |
| Inline `style={{ color: '#...' }}` | CSS class with token variable |
| Foundation and page tasks run in parallel | Foundation phase must fully complete first |

