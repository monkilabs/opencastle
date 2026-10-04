Frontend Design REFERENCE: the principles behind each dimension of a design.

## Design Principles (extended)

| Dimension | Rule |
|-----------|------|
| Direction | Pick a direction the subject suggests (brutally minimal, maximalist, retro-futuristic, luxury, brutalist, art deco, editorial…) and commit fully. Name it in 2–3 words. |
| Typography | Characterful display+body pair chosen for the subject; avoid Inter/Roboto/Arial defaults. `clamp()` fluid scale; heading lh ~1.1–1.2, body lh ~1.5–1.7 (serif body a little more); lines under ~80 characters. |
| Color | CSS vars only; dominant + sharp accent hierarchy; WCAG AA (4.5:1 body, 3:1 large); dark/light both intentional. |
| Motion | CSS-only for HTML; Motion library for React. Motion only to draw attention: one orchestrated page-load sequence or one reveal, custom easing, `prefers-reduced-motion` fallback. |
| Layout | Asymmetry, overlap, diagonal flow, grid-breaking. Consistent spacing tokens — no ad-hoc values. Holds at mobile/tablet/desktop. |
| Atmosphere | Gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, each only where it serves the direction. |

Link lessons and PRs that change foundational tokens to the **project-consistency** skill guidance.
