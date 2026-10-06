---
name: frontend-design
description: "Visual direction for distinctive pages: a named aesthetic, type pairing, color and spacing tokens, and motion. Use when designing a landing page, marketing site or UI theme where the look itself matters, not when scaffolding components."
---

# Frontend Design

## Design Workflow

1. **Ground it in the subject.** Read the brief and the product: who it is for, what it sells, what it should feel like.
2. **Write a short plan** in a comment at the top of the main CSS file: the aesthetic named in 2–3 words, 4–6 named colors, the type pairing and the role of each face, one sentence per layout, and the one unforgettable detail.
3. **Critique the plan against the brief** before writing code. Every choice that would fit any other product, or matches a tell below, gets replaced.
4. Define every color, space, and radius as a `:root` custom property; build components from those tokens only — no ad-hoc values.
5. Wrap motion in `@media (prefers-reduced-motion: no-preference)`; keep key animations under 500ms.
6. Verify before marking done: contrast ≥4.5:1 body text and ≥3:1 large text, no overflow at mobile sizes.

## Avoid the generic look

These read as AI-generated on sight:

- A fade-and-slide-up (`fadeUp`) entrance on every section, or a staggered hero reveal. Use one orchestrated page-load moment, or none.
- Glass cards, and identical rounded cards with a soft grey shadow (`rgba(0,0,0,.12)`) that lift on hover.
- A near-black background with a single bright orange, acid-green or vermilion accent; a cream background with a serif display and terracotta.
- Inter, Roboto, Arial or the system stack as the display face; purple gradients on white.
- Template chrome: tracked all-caps labels, middle-dot metadata, one accented word in the headline.

Design principles and the reasoning behind them: [REFERENCE.md](./REFERENCE.md).

## Typography

Choose a pairing that fits the subject. Always ship a metric-preserving fallback chain (e.g. `'Fraunces', 'Georgia', serif`).

## Several agents building UI at once

Build the foundation first, in one task, and start the pages only when it is done: the design tokens (`:root` custom properties in one file), the shared layout, and the UI components. Every page task then imports those and adds none of its own — no new color, font or spacing value, no copied component, no inline `style`. Give each page task the paths to the tokens, the layout and the components, the aesthetic in its 2–3 words, and the content tone.
