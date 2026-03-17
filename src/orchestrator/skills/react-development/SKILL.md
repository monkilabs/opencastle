---
name: react-development
description: "React development standards for functional components, hooks, TypeScript integration, state management, styling, and testing patterns. Use when creating or modifying React components, custom hooks, or component tests."
---

# React Development Standards

Modern React patterns — https://react.dev.

## Architecture & Components

- Functional components + hooks; composition over inheritance.
- Feature/domain folders; separate presentational and container components.
- PascalCase names; single responsibility; destructure props; never mutate props/state.
- `<>...</>` to avoid extra DOM nodes; props validated via TypeScript.

## TypeScript

- Interfaces for props, state, event handlers, refs, and API responses.
- Generic components where appropriate; union types for variants.
- Built-ins: `React.FC`, `React.ComponentProps`, etc.
- Strict mode in `tsconfig.json`; shared types in `interfaces/`.

## State & Hooks

| Concern | Tool |
|---------|------|
| Local state | `useState` |
| Complex state | `useReducer` |
| Cross-tree state | `useContext` |
| Server state | React Query |
| DOM / mutable ref | `useRef` |
| Perf optimization | `useMemo` / `useCallback` |

- `useEffect`: proper deps, cleanup to prevent leaks.
- Hooks only at top level; extract reusable logic to custom hooks.

## Styling

- **CSS Modules** (`.module.scss`) co-located with components.
- Sass for advanced features; variables/mixins from shared libraries.
- Mobile-first responsive; CSS custom properties for theming.

## Performance

- Stable `key` props; `React.memo` where warranted.
- Code-split with `React.lazy` + `Suspense`; dynamic imports.
- Avoid anonymous functions in render; virtual scrolling for large lists.
- `ErrorBoundary` for graceful degradation.

## Data Fetching

- Libraries: React Query, SWR, or Apollo Client.
- Always handle loading/error/success; cancel on unmount; optimistic updates.

## Forms

- Controlled components; React Hook Form + Zod for validation.
- Accessibility: labels, ARIA attributes; debounced validation.

## Testing

- React Testing Library (behavior, not implementation); Jest runner.
- Co-locate tests in `__tests__`; mock external deps and API calls.
- Test accessibility and keyboard navigation.
- **CRITICAL**: Never mix static imports and `require()` for lazy-loaded libs in tests — use `jest.requireMock()` / `jest.requireActual()`.

## Security

- Sanitize inputs (XSS); validate/escape before rendering.
- HTTPS for external APIs; no sensitive data in localStorage/sessionStorage; CSP headers.
