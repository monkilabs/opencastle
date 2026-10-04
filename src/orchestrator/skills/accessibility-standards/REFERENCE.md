## Composite Widgets & Form Error Handling (Reference)

Composite widgets (menu, listbox, tabs, grid) take one Tab stop and manage focus inside with the arrow keys. Use one of two patterns.

### Roving tabindex pattern

Focus moves onto the items themselves.

1. The focused item has `tabindex="0"`; every other item has `tabindex="-1"`. The container gets no `tabindex`.
2. Arrow keys move `tabindex="0"` to the next item and call `.focus()` on it.
3. Tabbing out and back returns to the item that last had focus.

```html
<div role="tablist" aria-label="Settings">
  <button role="tab" id="tab-1" aria-selected="true" tabindex="0">Profile</button>
  <button role="tab" id="tab-2" aria-selected="false" tabindex="-1">Billing</button>
</div>
```

### `aria-activedescendant` pattern

Focus stays on the container (`tabindex="0"`); `aria-activedescendant` names the `id` of the visually active child. Update the attribute on arrow navigation.

```html
<div role="listbox" tabindex="0" aria-activedescendant="item-1">
  <div id="item-1" role="option">Item 1</div>
  <div id="item-2" role="option">Item 2</div>
</div>
```

### Form error handling

- On validation error, add `aria-invalid="true"` and `aria-describedby="error-id"` to the input (an ID reference, no `#`).
- Ensure the error element has role `alert` or is announced by screen readers when it appears.
- Move focus to the first invalid control and programmatically announce error summary.

### Skip links & focus management

Provide a visible `skip to main` link as first focusable element. Ensure `main` has an `id` target.
