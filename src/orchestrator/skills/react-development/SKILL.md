---
name: react-development
description: "Enforces React-specific patterns: functional components with hooks, TypeScript prop interfaces, CSS Modules co-location, React Testing Library behavioral tests. Use when creating React components, writing custom hooks, structuring component folders, applying RTL test patterns, or wiring TypeScript prop types. Trigger terms: React, .tsx, component, hook, RTL, jsx, useState, useEffect, prop interface"
---

# React Development Standards

## Conventions

- One component per file: `ComponentName.tsx` inside its feature folder, co-located with `ComponentName.module.scss` and `ComponentName.test.tsx`.
- Export the props type as `ComponentNameProps`; PascalCase component names.
- Styling: CSS Modules (`.module.scss`), Sass variables/mixins pulled from the shared libraries, CSS custom properties for theming.
- `strict` stays enabled in `tsconfig.json`; no `as` casts.
- Tests: React Testing Library on the runner bound to the **testing** capability slot, mocking external deps and API calls.

## Verification

Lint, typecheck, test, and build must all exit zero. Resolve the exact commands
via the **codebase-tool** slot; `.opencastle/project.instructions.md` records the
project's package manager and script names.

## Security

Sanitize user-supplied HTML (e.g. `dompurify`) before rendering. Client-side validation is never sufficient on its own — see **api-patterns** for server validation.
