---
name: project-consistency
description: "Enforce cross-agent consistency in multi-page/multi-component projects. Covers visual design, code patterns, content style, and structural conventions. Essential for convoy parallel execution where multiple agents build different parts of the same app."
---

# Project Consistency

When multiple agents build different pages or sections in parallel, each makes independent decisions about colors, fonts, component APIs, content tone, and page structure. Without coordination, the result looks like it was built by five different teams — because it was.

**The fix is architectural, not aspirational.** Consistency cannot be "hoped for" after parallel work is done. It must be engineered as shared inputs before parallel work begins.

## The Foundation-First Principle

```
❌ Wrong:  [agent A] ─┐                         → inconsistent output
           [agent B] ─┤→ build pages in parallel → inconsistent output
           [agent C] ─┘                         → inconsistent output

✅ Right:  [foundation task] → shared artifacts → [agent A] ─┐
                                                  [agent B] ─┤→ consistent output
                                                  [agent C] ─┘
```

**Phase 1 (sequential):** One task creates all shared artifacts — design tokens, layout component, UI library, style guide.  
**Phase 2 (parallel):** Every page task imports from Phase 1 output. No new values, no recreated components.

### The 4 Consistency Dimensions

| Dimension | What drifts without a contract | Artifact that enforces it |
|-----------|-------------------------------|--------------------------|
| **Visual** | Color palettes, font choices, spacing units | Design tokens file |
| **Code** | Component APIs, naming conventions, import paths | UI component library |
| **Content** | Tone, terminology, heading hierarchy | Style guide brief |
| **Structural** | Page layout, navigation, responsive breakpoints | Shared layout component |

---

## Foundation Phase Artifacts

A foundation task must produce four things. All subsequent tasks depend on its completion.

### a. Design Tokens File

A single CSS custom properties file — the system's single source of truth. No agent may introduce a color, size, or timing value outside this file.

**Path:** `src/styles/tokens.css` (or equivalent for your framework)

Define a comprehensive `:root` CSS custom properties file covering palette, typography scale, spacing, motion, shadows, radius, and breakpoints. See the **frontend-design** skill for a full example.

> **Rule:** If a value isn't a token, it doesn't belong in a component stylesheet. Period.

### b. Shared Layout Component

Wraps every page. Provides the header, navigation, footer, and responsive container. Every page agent imports this — never creates its own.

**Path:** `src/components/Layout.tsx` (React) or `src/layouts/Layout.astro` (Astro)

The layout must handle:
- Responsive container (`max-width: var(--container-xl)`, centered, padded)
- Site header with navigation (labels defined in style guide brief)
- Site footer
- Consistent page padding using spacing tokens
- Document head (meta tags, fonts, canonical URL)

### c. UI Component Library

Shared primitives that every page agent imports. Each component uses only design tokens — zero hardcoded values.

**Path:** `src/components/ui/`

Minimum required components: `Button` (primary/secondary/ghost), `Card` (default/bordered/elevated), `Heading` (h1–h6 via level prop), `Text` (sm/base/lg), `Link`, `Section` (vertical spacer), `Container`, `Grid`.

Component API rules (defined once, followed by all):
- Props use camelCase
- Variant selection via `variant` prop (string union)
- Size selection via `size` prop (string union)
- All components accept `className` for one-off overrides
- No inline `style` props in library components

### d. Style Guide Brief

Defined inline in the foundation task prompt (not a separate file). Page task prompts must quote it verbatim.

Required fields:
- **Aesthetic direction:** 2–3 words (`warm editorial`, `cold brutalist`, `soft playful`)
- **Typography pairing:** display font + body font + mono (if used)
- **Content tone:** formal/casual, active/passive, sentence length preference
- **Navigation labels:** exact labels for every nav link (prevents terminology drift)
- **Page structure pattern:** the default sequence (e.g., `hero → intro → features → CTA → footer`)
- **Terminology glossary:** any project-specific terms that could be said multiple ways (pick one)

---

## Consistency Rules for Page Agents

Every agent building a page in a multi-agent convoy MUST follow these rules. Non-negotiable.

### Visual
- Import tokens from the tokens file. **Never introduce a new color value, font size, or spacing value.**
- If a value you need doesn't exist as a token, stop and flag it — don't invent an inline value and move on.
- Use CSS custom properties exclusively. No raw hex, no raw `px` values in stylesheets.

### Code
- Import `Layout` from the shared layout path. Do not create a page-local layout wrapper.
- Import `Button`, `Card`, `Heading`, etc. from the UI library path. Do not recreate them.
- Follow the naming conventions: PascalCase components, camelCase props, kebab-case CSS classes.
- Co-locate component files (component, styles, tests) — do not scatter across `pages/`, `styles/`, and `components/`.

### Content
- Match the tone from the style guide brief exactly. If the brief says "conversational and direct," don't write formal passive-voice copy.
- Use the terminology glossary. If the brief says "projects" (not "work" or "portfolio"), use "projects" everywhere.
- Follow the heading hierarchy pattern. If H1 is the page title and H2 introduces sections, don't invent new patterns.

### Structural
- Every page uses the shared Layout component — no exceptions.
- Follow the page structure pattern from the style guide brief (`hero → content → CTA`, etc.).
- Navigation labels must match the style guide brief exactly — no paraphrasing.
- Responsive breakpoints come from the tokens file (`--container-sm/md/lg/xl`). Define no new breakpoints.

---

## Convoy Integration Pattern

```
Phase 1: foundation-setup  (1 task, blocks Phase 2)
├── Agent:  UI-UX Expert or Developer
├── Creates: tokens.css, Layout component, UI component library
├── Defines: style guide brief (aesthetic, tone, nav labels, terminology)
└── Output:  all paths documented for Phase 2 task prompts

Phase 2: page-building  (N tasks, all parallel)
├── home-page
├── about-page
├── projects-page
├── contact-page
└── [every task prompt contains the 5 mandatory references below]
```

### 5 Mandatory References in Every Page Task Prompt

```
1. Design tokens:    `[path to tokens.css]` — use ONLY these tokens. No new values.
2. Layout:           `[path to Layout]` — wrap all page content in this component.
3. UI components:    `[path to src/components/ui/]` — import; do not recreate.
4. Aesthetic:        [2-3 word direction from foundation]
5. Content tone:     [tone description from foundation]
```

These are **inputs** to the task, not suggestions.

---

## Prompt Template: Foundation Task

Copy and fill in. This prompt goes to a single agent before parallel work begins.

````markdown
## Foundation Setup — [project description]

**Aesthetic:** [2-3 word direction] — [one sentence]

Create `[path]/tokens.css`: palette (intent-named), fluid typography (clamp()), spacing (4px base), motion, shadows, radius, breakpoints.  
Create `[path]/Layout.[tsx|astro|vue]`: responsive container, site header (nav: [labels]), footer, document head.  
Create `[path]/ui/`: Button, Card, Heading, Text, Link, Section, Container, Grid — tokens only, zero hardcoded values; `variant`/`size`/`className` API.

**Style Guide:** Tone: [formal/casual]. Terminology: [key terms]. Page structure: [hero → ... → CTA].

**Acceptance Criteria:** Zero hardcoded hex/px · Layout responsive at 320/768/1280px · Fluid typography via clamp() · Fonts loaded efficiently
````

---

## Prompt Template: Page Task

Copy and fill in for each parallel page task.

````markdown
## Build [Page Name] Page — [purpose, audience, primary action]

**MANDATORY refs:** tokens: `[path]/tokens.css` (no new values) · Layout: `[path]/Layout.[ext]` (wrap all content) · UI: `[path]/ui/` (import, don't recreate) · Aesthetic: [2-3 words] · Tone: [tone] · Terms: [glossary]

**Content:** [sections, copy direction, media]  **Structure:** [hero → ... → CTA] (from foundation brief)

**Acceptance Criteria:** Shared Layout used · Zero hardcoded values · UI components imported · Tone/terminology match · Responsive 320/768/1280px · [page-specific]
````

---

## Anti-Patterns

These will produce an inconsistent result regardless of individual page quality.

- **Agents pick their own fonts/colors** → foundation task creates tokens first
- **Page-local `styles/global.css`** → one shared tokens file, imported once
- **Copy-pasting `Button` between pages** → import from shared library
- **Inline `style={{ color: '#...' }}`** → CSS class with token variable
- **Skipping foundation "for a simple site"** → foundation takes 1 task, saves N fixes
- **Different terminology per page** → terminology glossary in style guide brief
- **Foundation and page tasks run in parallel** → foundation phase must fully complete first

