---
name: frontend-design
description: "Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics."
license: Complete terms in LICENSE.txt
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

## Design Principles

| Dimension | Rule |
|-----------|------|
| Direction | Pick an extreme aesthetic (brutally minimal, maximalist, retro-futuristic, luxury, brutalist, art deco, editorial…) and commit fully. Name it in 2–3 words. |
| Typography | Characterful display+body pair. No Inter/Roboto/Arial. `clamp()` fluid scale; heading lh ~1.1–1.2, body lh ~1.5–1.7; letter-spacing on uppercase/small. |
| Color | CSS vars only; dominant + sharp accent hierarchy; WCAG AA (4.5:1 body, 3:1 large); dark/light both intentional. |
| Motion | CSS-only for HTML; Motion library for React; staggered page entrance; custom easing; `prefers-reduced-motion` fallback. |
| Layout | Asymmetry, overlap, diagonal flow, grid-breaking. Consistent spacing tokens — no ad-hoc values. Holds at mobile/tablet/desktop. |
| Atmosphere | Gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows. No purple-on-white defaults. |

**Every design must have one unforgettable detail.** No two designs should look alike.

## Design System Foundations

```css
:root {
  --color-ink:     #1a1614;  --color-paper:   #f5f0e8;
  --color-accent:  #c8e630;  --color-muted:   #9b9083;
  --color-surface: #eae3d8;  --color-border:  rgba(26, 22, 20, 0.08);

  --text-sm:   clamp(0.875rem, 0.83rem + 0.22vw, 1rem);
  --text-base: clamp(1rem, 0.95rem + 0.25vw, 1.125rem);
  --text-xl:   clamp(1.563rem, 1.35rem + 1.06vw, 2rem);
  --text-2xl:  clamp(1.953rem, 1.6rem + 1.77vw, 2.75rem);
  --text-hero: clamp(2.441rem, 1.8rem + 3.2vw, 4.5rem);

  --space-2: 0.5rem; --space-4: 1rem;  --space-6: 1.5rem;
  --space-8: 2rem;   --space-16: 4rem; --space-32: 8rem;

  --ease-out-expo:    cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out-back: cubic-bezier(0.68, -0.6, 0.32, 1.6);
  --duration-fast: 150ms; --duration-normal: 300ms; --duration-slow: 600ms;

  --shadow-md: 0 4px 16px rgba(26, 22, 20, 0.08);
  --shadow-lg: 0 12px 48px rgba(26, 22, 20, 0.12);
}
```

## Component Patterns

**Card:**
```css
.card {
  position: relative;
  background: var(--color-paper);
  border: 1px solid var(--color-border);
  border-left: 4px solid var(--color-accent);
  padding: var(--space-8) var(--space-6);
  transition: transform var(--duration-normal) var(--ease-out-expo),
              box-shadow var(--duration-normal) var(--ease-out-expo);
}
.card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); }
.card__label {
  position: absolute; top: calc(-1 * var(--space-3)); left: var(--space-4);
  background: var(--color-accent); color: var(--color-ink);
  font-size: var(--text-xs); font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
  padding: var(--space-1) var(--space-3);
}
```

**Hero staggered reveal:**
```css
@keyframes rise {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
.hero           { overflow: hidden; padding: var(--space-32) var(--space-8); }
.hero__eyebrow  { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 100ms; }
.hero__headline { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 250ms; }
.hero__body     { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 400ms; }
.hero__cta      { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 550ms; }
```

## Typography Pairings

| Aesthetic | Display | Body | Mood |
|-----------|---------|------|------|
| Editorial luxury | Playfair Display | Source Serif 4 | Authoritative, rich |
| Swiss precision | Darker Grotesque | IBM Plex Sans | Sharp grotesque |
| Warm humanist | Fraunces | Nunito Sans | Friendly, approachable |
| Brutalist edge | Monument Extended | JetBrains Mono | Raw technical power |
| Art nouveau organic | Cormorant Garamond | Lora | Flowing, calligraphic |
| Retro-futuristic | Syne | Outfit | Geometric boldness |

Include a metric-preserving fallback chain (e.g., `'Fraunces', 'Georgia', serif`).

## Quality Checklist

**Identity:** aesthetic named in 2–3 words · color/type/space/motion tell one story · one memorable detail

**Typography:** display+body pair distinct · `clamp()` fluid scale · heading lh ~1.1–1.2 / body lh ~1.5–1.7 · letter-spacing on uppercase/small

**Color:** CSS vars only · dominant+accent hierarchy · WCAG AA (4.5:1 body, 3:1 large) · dark/light both intentional

**Layout:** spacing tokens throughout · one grid-breaking element · responsive at mobile/tablet/desktop

**Motion:** coordinated entrance sequence · hover/focus on all interactives · custom easing curves · `prefers-reduced-motion` fallback

**Production:** no hardcoded widths · `alt`/`aria-hidden` on images · visible focus indicators · no scroll-animation layout thrashing

> Load the **project-consistency** skill for the full Foundation Phase pattern and prompt templates.