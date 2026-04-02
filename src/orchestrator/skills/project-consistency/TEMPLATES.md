> Parent: [SKILL.md](./SKILL.md)

## Prompt Templates — Foundation & Page Tasks

### Foundation Setup — Prompt (copy-paste)

````markdown
## Foundation Setup — [project description]

**Aesthetic:** [2-3 word direction] — [one sentence]

Create `[path]/tokens.css`: palette (intent-named), fluid typography (clamp()), spacing (4px base), motion, shadows, radius, breakpoints.
Create `[path]/Layout.[tsx|astro|vue]`: responsive container, site header (nav: [labels]), footer, document head.
Create `[path]/ui/`: Button, Card, Heading, Text, Link, Section, Container, Grid — tokens only, zero hardcoded values; `variant`/`size`/`className` API.

**Style Guide:** Tone: [formal/casual]. Terminology: [key terms]. Page structure: [hero → ... → CTA].

**Acceptance Criteria:** Zero hardcoded hex/px · Layout responsive at 320/768/1280px · Fluid typography via clamp() · Fonts loaded efficiently
````

### Page Task — Prompt (copy-paste)

````markdown
## Build [Page Name] Page — [purpose, audience, primary action]

**MANDATORY refs:** tokens: `[path]/tokens.css` (no new values) · Layout: `[path]/Layout.[ext]` (wrap all content) · UI: `[path]/ui/` (import, don't recreate) · Aesthetic: [2-3 words] · Tone: [tone] · Terms: [glossary]

**Content:** [sections, copy direction, media]  **Structure:** [hero → ... → CTA]

**Acceptance Criteria:** Shared Layout used · Zero hardcoded values · UI components imported · Tone/terminology match · Responsive 320/768/1280px · [page-specific]
````

### How to use

- Copy the appropriate template into the foundation or page task tracker issue.
- Replace bracketed placeholders (`[path]`, `[Aesthetic]`) with exact values from the foundation task outputs.
- Attach paths to tokens, Layout, and UI component library explicitly in the prompt.

Last Updated: 2026-03-31
