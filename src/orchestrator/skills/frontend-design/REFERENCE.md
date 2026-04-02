> Parent: [SKILL.md](./SKILL.md)

Frontend Design REFERENCE: detailed principles, typography catalogue, tokens, and component patterns.

Last Updated: 2026-03-31

## Design Principles (extended)

| Dimension | Rule |
|-----------|------|
| Direction | Pick an extreme aesthetic (brutally minimal, maximalist, retro-futuristic, luxury, brutalist, art deco, editorial…) and commit fully. Name it in 2–3 words. |
| Typography | Characterful display+body pair. No Inter/Roboto/Arial. `clamp()` fluid scale; heading lh ~1.1–1.2, body lh ~1.5–1.7; letter-spacing on uppercase/small. |
| Color | CSS vars only; dominant + sharp accent hierarchy; WCAG AA (4.5:1 body, 3:1 large); dark/light both intentional. |
| Motion | CSS-only for HTML; Motion library for React; staggered page entrance; custom easing; `prefers-reduced-motion` fallback. |
| Layout | Asymmetry, overlap, diagonal flow, grid-breaking. Consistent spacing tokens — no ad-hoc values. Holds at mobile/tablet/desktop. |
| Atmosphere | Gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows. No purple-on-white defaults. |

## Typography Pairings (catalogue)

| Aesthetic | Display | Body | Mood |
|-----------|---------|------|------|
| Editorial luxury | Playfair Display | Source Serif 4 | Authoritative, rich |
| Swiss precision | Darker Grotesque | IBM Plex Sans | Sharp grotesque |
| Warm humanist | Fraunces | Nunito Sans | Friendly, approachable |
| Brutalist edge | Monument Extended | JetBrains Mono | Raw technical power |
| Art nouveau organic | Cormorant Garamond | Lora | Flowing, calligraphic |
| Retro-futuristic | Syne | Outfit | Geometric boldness |

## Tokens & Patterns

See `COMPONENTS.md` for tokens and component code snippets. This reference holds the rationale and extended examples used across projects.

## Usage

- Use these tables to choose a type system and enforce token fallbacks.
- Link lessons and PRs that change foundational tokens to the `project-consistency` skill guidance.
