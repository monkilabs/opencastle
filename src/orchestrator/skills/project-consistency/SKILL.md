---
name: project-consistency
description: "Enforce cross-agent consistency in multi-page/multi-component projects. Use when planning a convoy with parallel page-building tasks, when multiple agents will create UI components, or when reviewing multi-agent output for visual/code/content drift. Covers visual design, code patterns, content style, and structural conventions."
---

# Project Consistency

Multiple agents building in parallel make independent decisions about colors, fonts, APIs, and tone. **Consistency must be engineered as shared inputs before parallel work begins — not hoped for afterward.**

## Foundation-First Principle

```
❌ Wrong:  [A] ─┐                    → inconsistent output
           [B] ─┤→ build in parallel → inconsistent output
           [C] ─┘                    → inconsistent output

✅ Right:  [foundation] → artifacts → [A] ─┐
                                      [B] ─┤→ consistent output
                                      [C] ─┘
```

**Phase 1 (sequential):** One task creates all shared artifacts.  
**Phase 2 (parallel):** Every page task imports from Phase 1. No new values, no recreated components.

### The 4 Consistency Dimensions

| Dimension | What drifts | Artifact |
|-----------|-------------|----------|
| **Visual** | Color palettes, font choices, spacing units | Design tokens file |
| **Code** | Component APIs, naming conventions, import paths | UI component library |
| **Content** | Tone, terminology, heading hierarchy | Style guide brief |
| **Structural** | Page layout, navigation, responsive breakpoints | Shared layout component |

---

## Foundation Phase Artifacts

A foundation task must produce four artifacts. All phase-2 tasks depend on its completion.

| Artifact | Path | Contents |
|----------|------|----------|
| **Design tokens** | `src/styles/tokens.css` | CSS custom properties: palette, typography, spacing, motion, shadows, radius, breakpoints. **Rule:** no value outside this file. |
| **Shared layout** | `src/components/Layout.tsx` (React) · `src/layouts/Layout.astro` (Astro) | Wraps every page: responsive container, header, nav, footer, document head. Import — never recreate. |
| **UI component library** | `src/components/ui/` | `Button`, `Card`, `Heading`, `Text`, `Link`, `Section`, `Container`, `Grid` — tokens only. API: camelCase props, `variant`/`size`/`className`, no inline `style`. |
| **Style guide brief** | Inline in foundation prompt (quoted verbatim in page prompts) | Aesthetic direction · typography pairing · content tone · nav labels · page structure pattern · terminology glossary |

---

## Consistency Rules for Page Agents

Every page agent in a multi-agent convoy MUST follow all rules below.

| Area | Rules |
|------|-------|
| **Visual** | Import tokens only. Never introduce new color, font-size, or spacing values. Flag missing tokens — don't invent inline values. CSS custom properties exclusively; no raw hex or raw `px`. |
| **Code** | Import `Layout` from shared path — no page-local wrappers. Import UI components from library — don't recreate. PascalCase components, camelCase props, kebab-case CSS classes. Co-locate component files. |
| **Content** | Match tone from style guide exactly. Use terminology glossary verbatim. Follow heading hierarchy pattern. |
| **Structural** | Every page uses shared Layout — no exceptions. Follow page structure from brief. Nav labels match brief exactly. Breakpoints from tokens only. |

---

## Workflow

### Step 1 — Create Foundation Artifacts

Before any parallel work begins, a single foundation task creates all shared artifacts (see Foundation Phase Artifacts above). This task must complete before Phase 2 starts.

**Validation checkpoint:** Verify all four artifacts exist — design tokens file, shared layout component, UI component library, and style guide brief — before launching parallel page agents.

### Step 2 — Launch Parallel Page Tasks

Each page task receives the 5 mandatory references (below) in its delegation prompt. Agents import from shared artifacts — no new values, no recreated components.

### Step 3 — Verify Consistency

After all page agents complete, review output across all pages for drift in colors, fonts, spacing, component APIs, and content tone. Flag any hardcoded values or locally recreated components.

**Validation checkpoint:** Confirm zero hardcoded hex/px values, all pages use the shared Layout, and terminology matches the style guide glossary.

## Convoy Integration

```
Phase 1: foundation-setup  (1 task, blocks Phase 2)
├── Agent:  UI-UX Expert or Developer
├── Creates: tokens.css, Layout, UI component library
├── Defines: style guide brief (aesthetic, tone, nav labels, terminology)
└── Output:  all paths documented for Phase 2 prompts

Phase 2: page-building  (N tasks, all parallel)
├── home-page · about-page · projects-page · contact-page · ...
└── [every prompt contains the 5 mandatory references below]
```

### 5 Mandatory References in Every Page Task Prompt

```
1. Design tokens:  `[path/tokens.css]` — use ONLY these tokens. No new values.
2. Layout:         `[path/Layout]` — wrap all page content in this component.
3. UI components:  `[path/src/components/ui/]` — import; do not recreate.
4. Aesthetic:      [2-3 word direction from foundation]
5. Content tone:   [tone description from foundation]
```

---

## Prompt Template: Foundation Task

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

````markdown
## Build [Page Name] Page — [purpose, audience, primary action]

**MANDATORY refs:** tokens: `[path]/tokens.css` (no new values) · Layout: `[path]/Layout.[ext]` (wrap all content) · UI: `[path]/ui/` (import, don't recreate) · Aesthetic: [2-3 words] · Tone: [tone] · Terms: [glossary]

**Content:** [sections, copy direction, media]  **Structure:** [hero → ... → CTA]

**Acceptance Criteria:** Shared Layout used · Zero hardcoded values · UI components imported · Tone/terminology match · Responsive 320/768/1280px · [page-specific]
````

---

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Agents pick their own fonts/colors | Foundation creates tokens first |
| Page-local `styles/global.css` | One shared tokens file, imported once |
| Copy-pasting `Button` between pages | Import from shared library |
| Inline `style={{ color: '#...' }}` | CSS class with token variable |
| Skipping foundation "for a simple site" | Foundation takes 1 task, saves N fixes |
| Different terminology per page | Terminology glossary in style guide brief |
| Foundation and page tasks run in parallel | Foundation phase must fully complete first |

