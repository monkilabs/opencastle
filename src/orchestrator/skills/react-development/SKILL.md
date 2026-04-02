---
name: react-development
description: "Enforces naming conventions, prop typing patterns, file structure, and test coverage standards. Use when creating or modifying React components, custom hooks, or component tests. Trigger terms: React app, .tsx files, testing library, custom hooks, functional components"
---

# React Development Standards

<!-- Concrete actions moved into description and workflows; trigger terms are in frontmatter -->

## New Component Workflow

1. **Create file** — `ComponentName.tsx` in the feature folder; co-locate `ComponentName.module.scss` and `ComponentName.test.tsx`
2. **Define interface** — export `ComponentNameProps` with TypeScript; destructure in function signature
3. **Implement** — functional component with hooks; use CSS Modules for styling
4. **Test** — RTL behavioral tests; cover render, interaction, edge cases, accessibility
5. **Verify** — lint + type-check + test pass; visually confirm in browser if UI

## Architecture & Components (concise)

- Functional components with hooks. Follow domain/feature folder structure and co-locate tests/styles with components.
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

- Use interfaces for props and shared types; keep strict mode enabled in `tsconfig.json`. See [REFERENCE.md](REFERENCE.md) for detailed TypeScript patterns.

## Styling

- **CSS Modules** (`.module.scss`) co-located with components.
- Sass for advanced features; variables/mixins from shared libraries.
- CSS custom properties for theming.

<!-- Performance guidance trimmed; follow project-specific conventions and benchmark when needed. -->

## Testing

- React Testing Library (behavior, not implementation); Jest runner.
- Co-locate tests next to components; mock external deps and API calls.
- Test accessibility and keyboard navigation; verify component public surface via unit tests.

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

If `lint` fails: run `pnpm lint --fix` and re-run. If `typecheck` fails: inspect reported files; add missing types. If tests fail: run with `--runInBand` to collect stack traces and reproduce locally.

## Security

- Follow project conventions for input sanitization, secret handling, and CSP. See **api-patterns** for validation patterns.
