---
name: project-consistency
description: "Generates shared CSS variables, validates component naming conventions, creates layout pattern templates. Use when coordinating design system, theme, consistent styling, CSS variables, or component library across parallel agents."
---

# Project Consistency

Ensure consistency by producing shared artifacts, automated checks before parallel work begins.

## Foundation-First Principle

Phase 1 (sequential): create shared artifacts (tokens, Layout, UI components). Phase 2 (parallel): every page imports from Phase 1; no new tokens or duplicated components.

### Foundation Artifacts & Page Rules

| Artifact | Path | Page Agent Rules |
|----------|------|------------------|
| **Design tokens** | `src/styles/tokens.css` | Import only. Never introduce new color/font/spacing values. |
| **Shared layout** | `src/components/Layout.tsx` / `Layout.astro` | Wrap every page. Never recreate. |
| **UI components** | `src/components/ui/` | Import from library. PascalCase components, camelCase props. |
| **Style guide brief** | Inline in prompts | Match tone + terminology exactly. Follow heading hierarchy. |

**Validation checkpoints:**
1. Foundation complete: `tokens.css` has all palette/type/spacing vars, Layout renders, UI components compile.
2. Per-page: `grep -r .style={{. src/pages/` returns 0 hits (no inline styles). All imports resolve.

---

## Convoy Integration

Phase 1 (sequential): foundation-setup creates tokens, Layout, UI library, style guide brief. Phase 2 (parallel): every page task imports from Phase 1. Include these 5 references in every page prompt:

```
1. Design tokens path   2. Layout path   3. UI components path
4. Aesthetic direction   5. Content tone
```

Prompt templates: see [TEMPLATES.md](./TEMPLATES.md).

---

## Executable Examples

### Example: `src/styles/tokens.css`

```css
:root {
	/* Palette */
	--color-bg: #ffffff;
	--color-foreground: #0f172a;
	--color-primary: #0ea5e9;
	--color-primary-600: #0284c7;

	/* Typography */
	--font-base: 'Inter, system-ui, -apple-system, sans-serif';
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

### Minimal Button component example (React)

```tsx
import './tokens.css';
type ButtonProps = { children: React.ReactNode; variant?: 'primary' | 'ghost'; className?: string };
export function Button({ children, variant = 'primary', className = '' }: ButtonProps) {
	const base = 'px-4 py-2 rounded';
	const variantCls = variant === 'primary' ? 'bg-[var(--color-primary)] text-white' : 'bg-transparent';
	return <button className={`${base} ${variantCls} ${className}`}>{children}</button>;
}
```

---

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Agents pick their own fonts/colors | Foundation creates tokens first |
| Copy-pasting `Button` between pages | Import from shared library |
| Inline `style={{ color: '#...' }}` | CSS class with token variable |
| Foundation and page tasks run in parallel | Foundation phase must fully complete first |

