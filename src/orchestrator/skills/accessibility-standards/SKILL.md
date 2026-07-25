---
name: accessibility-standards
description: "WCAG 2.2 Level AA accessibility patterns for React/HTML/CSS. Use when creating or modifying UI components, forms, navigation, tables, images, or any user-facing elements. Covers keyboard navigation, screen reader semantics, low vision contrast, voice access, inclusive language."
---

# Accessibility Standards

Code must conform to [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/). Use people-first language ("person using a screen reader," not "blind user"); flag uncertain implementations with reasoning. Composite widget patterns (roving tabindex, `aria-activedescendant`) in REFERENCE.md.

## Contrast

- Body text ≥4.5:1; large text (18.5px bold / 24px) ≥3:1.
- Graphics, controls, and state indicators (pressed, focus, checked) ≥3:1 against adjacent colors.
- Color is never the sole conveyor of information.

## Keyboard

- No `tabindex` on static elements; `tabindex="-1"` only for elements receiving programmatic focus.
- Hidden elements must never be focusable.
- Skip link is the first focusable element, hidden via `.sr-only:not(:focus):not(:active) { clip-path: inset(50%); position: absolute; width: 1px; height: 1px; overflow: hidden; }`.
- Navigation: `<nav>` + `<ul>`, NOT `menu`/`menubar` roles. Toggle `aria-expanded`; roving tabindex across top-level items.

## Voice Access

An interactive element's accessible name must contain its visible label text — including when the name comes from `aria-label`.

## Forms

- Required fields: asterisk in label + `aria-required="true"`.
- Errors: `aria-invalid="true"` + `aria-describedby` pointing at the message.
- Never disable submit — show errors and focus the first invalid field.
- Disambiguate repeated labels ("Remove") with `aria-label`.

## Tables

`<table>` for static data; `role="grid"` with `role="gridcell"` nested in `role="row"` for interactive grids (date pickers, calendars).

## Page Title

Unique per page, front-loading the unique info: `"[Page] - [Section] - [Site]"`.

## Validation

Run `axe-core` (`axe-playwright` or `pa11y` in CI); fix all high/critical findings and re-run until clean. Tab through the page to confirm order and visible focus. [Accessibility Insights](https://accessibilityinsights.io/) for manual passes.
