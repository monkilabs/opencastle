---
name: frontend-design
description: "Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics."
license: Complete terms in LICENSE.txt
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

## Design Thinking

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme — brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian. Commit to one direction fully.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

## Frontend Aesthetics Guidelines

- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions; prioritize CSS-only for HTML, Motion library for React. Focus on high-impact moments — one orchestrated page load with staggered reveals (animation-delay) beats scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI aesthetics — overused fonts (Inter, Roboto, Arial, system fonts), clichéd gradients (purple on white), predictable layouts, or cookie-cutter patterns. No two designs should look alike.

Match implementation complexity to the aesthetic vision — maximalist designs need elaborate code; minimalist designs need restraint and precision.

## Design System Foundations

Define CSS custom properties for all values — never scatter raw hex/px through stylesheets.

```css
/* --- Palette: warm editorial with a punch of citron --- */
:root {
  --color-ink:        #1a1614;
  --color-paper:      #f5f0e8;
  --color-accent:     #c8e630;        /* citron — the memorable detail */
  --color-muted:      #9b9083;
  --color-surface:    #eae3d8;
  --color-border:     rgba(26, 22, 20, 0.08);

  /* Typography scale — modular ratio 1.25 (Major Third) */
  --text-sm:   clamp(0.875rem, 0.83rem + 0.22vw, 1rem);
  --text-base: clamp(1rem, 0.95rem + 0.25vw, 1.125rem);
  --text-xl:   clamp(1.563rem, 1.35rem + 1.06vw, 2rem);
  --text-2xl:  clamp(1.953rem, 1.6rem + 1.77vw, 2.75rem);
  --text-hero: clamp(2.441rem, 1.8rem + 3.2vw, 4.5rem);

  /* Spacing — 4px base, geometric progression */
  --space-2: 0.5rem;  --space-4: 1rem;
  --space-6: 1.5rem;  --space-8: 2rem;
  --space-16: 4rem;   --space-32: 8rem;

  /* Motion — intentional easing curves, not defaults */
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out-back: cubic-bezier(0.68, -0.6, 0.32, 1.6);
  --duration-fast: 150ms;
  --duration-normal: 300ms;
  --duration-slow: 600ms;

  /* Elevation */
  --shadow-md: 0 4px 16px rgba(26, 22, 20, 0.08);
  --shadow-lg: 0 12px 48px rgba(26, 22, 20, 0.12);
}
```

## Component Patterns

### Distinctive Card

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

.card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lg);
}

.card__label {
  position: absolute;
  top: calc(-1 * var(--space-3));
  left: var(--space-4);
  background: var(--color-accent);
  color: var(--color-ink);
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: var(--space-1) var(--space-3);
}
```

### Hero Section with Staggered Reveal

Orchestrate entrance animations with `animation-delay` for a cinematic first impression.

```css
@keyframes rise {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}

.hero              { overflow: hidden; padding: var(--space-32) var(--space-8); }
.hero__eyebrow     { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 100ms; }
.hero__headline    { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 250ms; }
.hero__body        { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 400ms; }
.hero__cta         { animation: rise var(--duration-slow) var(--ease-out-expo) both; animation-delay: 550ms; }
```

## Typography Pairing Examples

Starting points only — each project deserves a pairing chosen for its specific character.

| Aesthetic | Display | Body | Mood |
|-----------|---------|------|------|
| Editorial luxury | Playfair Display | Source Serif 4 | Authoritative, rich serif contrast |
| Swiss precision | Darker Grotesque | IBM Plex Sans | Sharp, high-contrast grotesque |
| Warm humanist | Fraunces | Nunito Sans | Friendly optical sizes, approachable |
| Brutalist edge | Monument Extended | JetBrains Mono | Wide + monospace = raw technical power |
| Art nouveau organic | Cormorant Garamond | Lora | Flowing, calligraphic sensibility |
| Retro-futuristic | Syne | Outfit | Geometric boldness meets clean body |

Always include a metric-preserving fallback chain (e.g., `'Fraunces', 'Georgia', serif`).

## Design Quality Checklist

### Identity & Cohesion
- [ ] Can you name the aesthetic direction in 2-3 words? (e.g., "warm editorial," "cold brutalist")
- [ ] Are color, typography, spacing, and motion all telling the same visual story?
- [ ] Is there at least one memorable detail — something unexpected that delights?

### Typography
- [ ] Display and body fonts are distinct and intentionally paired
- [ ] Type scale uses `clamp()` for fluid responsive sizing — no fixed `px` breakpoints
- [ ] Line heights are tuned: ~1.1–1.2 for headings, ~1.5–1.7 for body
- [ ] Letter-spacing is adjusted for uppercase text and small sizes

### Color & Contrast
- [ ] Palette is defined as CSS custom properties — no raw hex in component styles
- [ ] There is a clear dominant/accent hierarchy — not five competing colors
- [ ] Text passes WCAG AA contrast minimums (4.5:1 body, 3:1 large text)
- [ ] Dark/light theme (if applicable) is not just color inversion — both feel intentional

### Layout & Spacing
- [ ] Spacing flows from a consistent scale — no random `margin: 37px`
- [ ] At least one layout choice breaks the expected grid — overlap, bleed, asymmetry
- [ ] Component padding and gaps use spacing tokens, not ad-hoc values
- [ ] The design holds at mobile, tablet, and desktop without layout collapse

### Motion & Interaction
- [ ] Page entrance has a coordinated animation sequence (staggered reveals)
- [ ] Hover/focus states exist for all interactive elements
- [ ] Animations use custom easing curves — never `linear` or bare `ease`
- [ ] Motion serves narrative purpose — no decoration-only animation
- [ ] `prefers-reduced-motion` is respected with a `@media` query fallback

### Production Readiness
- [ ] No hardcoded widths that break at unexpected viewports
- [ ] Images and decorative elements have proper `alt` text or `aria-hidden`
- [ ] Focus indicators are visible and styled to match the aesthetic
- [ ] Performance: no layout thrashing from scroll-triggered animations without `will-change`

> Load the **project-consistency** skill for the full Foundation Phase pattern and prompt templates.