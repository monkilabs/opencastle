---
name: react-development
description: "React conventions for components, hooks, prop types, styling and React Testing Library tests. Use when creating or changing React components or hooks, or writing their tests."
---

# React Development Standards

## Conventions

- One component per file: `ComponentName.tsx` inside its feature folder, co-located with its styles and `ComponentName.test.tsx`.
- Export the props type as `ComponentNameProps`; PascalCase component names.
- Styling: follow the project's approach (CSS Modules, Tailwind, …), its shared tokens, and CSS custom properties for theming.
- `strict` stays enabled in `tsconfig.json`; no `as` casts.
- Tests: React Testing Library on the runner bound to the **testing** capability slot, mocking external deps and API calls.

## Verification

Lint, typecheck, test, and build must all exit zero. Resolve the exact commands
via the **codebase-tool** slot; `.opencastle/project.instructions.md` records the
project's package manager and script names.

## Security

Sanitize user-supplied HTML (e.g. `dompurify`) before rendering. Client-side validation is never sufficient on its own — see **api-patterns** for server validation.
