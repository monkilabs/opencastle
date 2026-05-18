---
name: frontend-design
description: "Defines named visual aesthetic, selects typography pairings, builds CSS token systems, adds entrance animations for high-design-quality pages. Use when user asks to design landing page, style marketing site, create distinctive UI theme, pick fonts, or add CSS animations — specifically when visual polish, brand identity matter rather than generic component scaffolding."
license: Complete terms in LICENSE.txt
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

## Design Workflow

1. **Name the aesthetic** — declare 2–3 word direction in code comment at top of main CSS file
2. **Set foundations** — define `:root` CSS custom properties for colors, spacing, radii
3. **Build components** — implement layout, cards, heroes, forms using only tokens from step 2
4. **Add motion** — add `@keyframes` entrance animations wrapped in reduced-motion guard
5. **Validate** — run Quality Checklist below; fix any failing item before marking done

### Quick-start example

```css
/* Aesthetic: minimal neon */
:root {
  --color-bg: #0a0a0f; --color-surface: #141420;
  --color-text: #e8e6e3; --color-accent: #6366f1;
  --space-sm: 8px; --space-md: 16px; --space-lg: 32px;
  --radius-md: 8px;
  --font-heading: 'Fraunces', 'Georgia', serif;
  --font-body: 'Inter', system-ui, sans-serif;
}
@keyframes fade-up {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: no-preference) {
  .hero__title { animation: fade-up 0.4s ease-out both; }
}
```

Card patterns, hero animations, extended token sets in [COMPONENTS.md](./COMPONENTS.md).

## Design Principles

High-level design principles, full example constraints live in [REFERENCE.md](./REFERENCE.md). Keep this checklist as short reminder:

- Pick named aesthetic (2–3 words); commit to it.
- Use tokenized colors/spacing; respect WCAG contrast; prefer semantic HTML.
- Respect `prefers-reduced-motion`; keep critical animations under 500ms.

**Every design must have one unforgettable detail.** No two designs should look alike.

## Typography Pairings

Recommended typography pairings, extended catalogue in [REFERENCE.md](./REFERENCE.md). For production, always include metric-preserving fallback chain (e.g., `.Fraunces., .Georgia., serif`).

> Load **project-consistency** skill for full Foundation Phase pattern, prompt templates.

### Quality Checklist (quick)

- **Contrast:** Text ≥4.5:1 body, ≥3:1 large.
- **Tokens:** All spacing/colors in `:root` tokens; avoid ad-hoc values.
- **Responsiveness:** Layouts break at defined tokens; no overflow at mobile sizes.
- **Motion:** `prefers-reduced-motion` respected; key animations <500ms.
- **Accessibility:** Keyboard focus states visible; semantic HTML used.