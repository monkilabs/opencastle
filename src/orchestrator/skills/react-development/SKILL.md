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
- Tests: React Testing Library on Jest, mocking external deps and API calls.

## Verification

```bash
pnpm lint
pnpm typecheck   # use `pnpm tsc --noEmit` if the alias is absent
pnpm test        # single test: pnpm test -- -t <name>
pnpm build
```

## Security

Sanitize user-supplied HTML (e.g. `dompurify`) before rendering. Client-side validation is never sufficient on its own — see **api-patterns** for server validation.
