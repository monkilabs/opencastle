---
name: accessibility-standards
description: "WCAG 2.2 Level AA accessibility patterns for React/HTML/CSS. Use when creating or modifying UI components, forms, navigation, tables, images, or any user-facing elements. Covers keyboard navigation, screen reader semantics, low vision contrast, voice access, inclusive language."
---

# Accessibility Standards

Code must conform to [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/).

**Workflow:** Plan accessible implementation → generate → review against WCAG 2.2 → iterate. Suggest [Accessibility Insights](https://accessibilityinsights.io/) for testing.

**Language:** People-first ("person using a screen reader," not "blind user"). No ability stereotypes. Flag uncertain implementations with reasoning.

## Cognitive

Plain language; consistent landmarks, nav order across pages; minimal distractions.

## Keyboard

- All interactive elements keyboard-navigable with visible focus in reading order.
- No `tabindex` on static elements; `tabindex="-1"` only for elements receiving programmatic focus.
- Hidden elements must not be focusable.

**Composite components** + detailed complex patterns moved to REFERENCE.md to keep this skill focused. See REFERENCE.md for roving tabindex, `aria-activedescendant`, composite widget examples.

### Validation checkpoints (run-fix-repeat)

- Run automated audit: `npx axe-core` or integrate `axe-core`/`axe-playwright` in CI — fix high/critical findings.
- Verify keyboard tab order manually: `Tab` through page, ensure logical order, visible focus.
- Confirm contrast ratios (spot-check key pages): use `axe`, `pa11y`, or `contrast` tools; ensure ≥4.5:1 for body text.
- Fix; re-run audits; repeat until no high/critical a11y issues remain.

**Skip link** (first focusable element):

```html
<a href="#maincontent" class="sr-only">Skip to main</a>
<main id="maincontent"></main>
```

```css
.sr-only:not(:focus):not(:active) { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
```

| Key | Action |
|-----|--------|
| `Tab` | Next interactive element |
| `Arrow` | Navigate within composite component |
| `Enter` | Activate focused control |
| `Escape` | Close dialogs/menus |

## Low Vision

| Rule | Requirement |
|------|-------------|
| Text contrast | ≥4.5:1 (≥3:1 for large text: 18.5px bold / 24px) |
| Graphics/controls | ≥3:1 with adjacent colors |
| State indicators (pressed, focus, checked) | ≥3:1 |
| Color | Never the sole conveyor of information |

## Screen Reader

- Correct semantics (name, role, value, states). Prefer native HTML; ARIA only when necessary.
- Landmarks: `<header>`, `<nav>`, `<main>`, `<footer>`.
- One `<h1>` per page; `<h1>`–`<h6>` introduce sections; no skipping levels.

## Voice Access

- Interactive element accessible name must contain its visible label text.
- `aria-label` must include visible label.

## Forms

- Labels accurately describe control purpose.
- Required fields: asterisk in label + `aria-required="true"`.
- Errors: `aria-invalid="true"` + `aria-describedby` pointing to error message.
- Don't disable submit — show errors instead; focus first invalid field on submit.

## Images

| Type | Pattern |
|------|---------|
| Informative | `alt="[meaning]"` on `<img>`; `role="img"` + `aria-label` on `<svg>` / icon fonts |
| Decorative | `alt=""` on `<img>`; `aria-hidden="true"` on `role="img"` |

## Input Labels

- `<label for="id">` for form inputs; all interactive elements need visible labels.
- Disambiguate repeated labels (e.g., "Remove") with `aria-label`.
- Help text via `aria-describedby`.

## Navigation

```html
<nav><ul>
  <li><button aria-expanded="false" tabindex="0">Section 1</button>
    <ul hidden><li><a href="..." tabindex="-1">Link 1</a></li></ul>
  </li>
</ul></nav>
```

- Use `<nav>` + `<ul>`, NOT `menu`/`menubar` roles.
- Toggle `aria-expanded` on expand/collapse; `Escape` closes menus.
- Roving tabindex across main items; arrow down into sub-menus.

## Page Title

- `<title>` describes page purpose, unique per page.
- Front-load unique info: `"[Page] - [Section] - [Site]"`.

## Tables & Grids

- Column headers: `<th>` in first `<tr>`; row headers: `<th>` in each row.
- `role="gridcell"` nested within `role="row"`.
- `<table>` for static data; `role="grid"` for interactive (date pickers, calendars).
