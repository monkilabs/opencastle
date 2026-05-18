---
name: react-development
description: "Enforces React-specific patterns: functional components with hooks, TypeScript prop interfaces, CSS Modules co-location, React Testing Library behavioral tests. Use when creating React components, writing custom hooks, structuring component folders, applying RTL test patterns, or wiring TypeScript prop types. Trigger terms: React, .tsx, component, hook, RTL, jsx, useState, useEffect, prop interface"
---

# React Development Standards

<!-- Concrete actions moved into description and workflows; trigger terms are in frontmatter -->

## New Component Workflow

1. **Create file** — `ComponentName.tsx` in feature folder; co-locate `ComponentName.module.scss`, `ComponentName.test.tsx`
2. **Define interface** — export `ComponentNameProps` with TypeScript; destructure in function signature
3. **Implement** — functional component with hooks; use CSS Modules for styling
4. **Test** — RTL behavioral tests; cover render, interaction, edge cases, accessibility
5. **Verify** — lint + type-check + test pass; visually confirm in browser if UI

## Architecture & Components (concise)

- Functional components with hooks. Follow domain/feature folder structure; co-locate tests/styles with components.
- PascalCase names; destructure props; use TypeScript interfaces for props.

```tsx
interface UserCardProps { name: string; role: string }
export function UserCard({ name, role }: UserCardProps) {
  return (
    <div data-testid="user-card">
      <h3>{name}</h3>
      <span>{role}</span>
    </div>
  );
}
```

## TypeScript

- Use interfaces for props, shared types; keep strict mode enabled in `tsconfig.json`. Generic constraints: `<T extends Record<string, unknown>>`. Discriminated unions for variant props. Avoid `as` casts.

## Styling

- **CSS Modules** (`.module.scss`) co-located with components.
- Sass for advanced features; variables/mixins from shared libraries.
- CSS custom properties for theming.

<!-- Performance guidance trimmed; follow project-specific conventions and benchmark when needed. -->

## Testing

- React Testing Library (behavior, not implementation); Jest runner.
- Co-locate tests next to components; mock external deps, API calls.
- Test accessibility, keyboard navigation; verify component public surface via unit tests.

```tsx
import { render, screen } from '@testing-library/react';
import { UserCard } from './UserCard';

test('renders user info', () => {
  render(<UserCard name="Alice" role="Admin" />);
  expect(screen.getByText('Alice')).toBeInTheDocument();
  expect(screen.getByTestId('user-card')).toBeInTheDocument();
});
```

## Verification commands + error recovery

Run these as part of your PR validation pipeline or locally:

```bash
pnpm lint        # fixable issues: pnpm lint --fix
pnpm typecheck   # run `pnpm tsc --noEmit` if alias not present
pnpm test        # rerun failing tests with `pnpm test -- -t <name>`
pnpm build       # ensure production build succeeds
```

If `lint` fails: run `pnpm lint --fix`; re-run. If `typecheck` fails: inspect reported files; add missing types. If tests fail: run with `--runInBand` to collect stack traces; reproduce locally.

## Security

- Sanitize user-supplied HTML before rendering (e.g. `dompurify`); never trust client validation alone — validate server-side. See **api-patterns** skill for server validation patterns.
