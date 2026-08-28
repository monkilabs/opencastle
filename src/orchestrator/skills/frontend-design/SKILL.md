---
name: frontend-design
description: "Defines named visual aesthetic, selects typography pairings, builds CSS token systems, adds entrance animations for high-design-quality pages. Use when user asks to design landing page, style marketing site, create distinctive UI theme, pick fonts, or add CSS animations — specifically when visual polish, brand identity matter rather than generic component scaffolding."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

## Design Workflow

1. Name the aesthetic in 2–3 words in a comment at the top of the main CSS file; commit to it.
2. Define every color, space, and radius as a `:root` custom property; build components from those tokens only — no ad-hoc values.
3. Wrap entrance animations in `@media (prefers-reduced-motion: no-preference)`; keep key animations under 500ms.
4. Verify before marking done: contrast ≥4.5:1 body text and ≥3:1 large text, no overflow at mobile sizes.

**Every design must have one unforgettable detail. No two designs should look alike.**

Card patterns, hero animations, extended token sets: [COMPONENTS.md](./COMPONENTS.md). Design principles, typography catalogue, example constraints: [REFERENCE.md](./REFERENCE.md).

## Typography

Always ship a metric-preserving fallback chain (e.g. `'Fraunces', 'Georgia', serif`).

> Load **project-consistency** skill for the full Foundation Phase pattern and prompt templates.
