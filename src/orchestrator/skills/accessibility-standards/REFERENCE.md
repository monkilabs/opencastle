> Parent: [SKILL.md](./SKILL.md)

## Composite Widgets & Form Error Handling (Reference)

### Roving tabindex pattern

Use when a composite widget (menu, listbox, tabs) manages focus internally.

1. Container receives `tabindex="0"` and keyboard handlers.
2. Children are `tabindex="-1"` except one `tabindex="0"` representing active item.
3. Arrow keys update `tabindex` values and call `.focus()` on the new active child.

Example:

```html
<div role="listbox" tabindex="0" aria-activedescendant="item-1">
  <div id="item-1" role="option">Item 1</div>
  <div id="item-2" role="option">Item 2</div>
</div>
```

### `aria-activedescendant` pattern

When focus remains on a container but a child is visually active, use `aria-activedescendant` referencing the active child's `id`. Update the attribute on arrow navigation.

### Form error handling

- On validation error, add `aria-invalid="true"` and `aria-describedby="#error-id"` to the input.
- Ensure the error element has role `alert` or is announced by screen readers when it appears.
- Move focus to the first invalid control and programmatically announce error summary.

### Skip links & focus management

Provide a visible `skip to main` link as first focusable element. Ensure `main` has an `id` target.
