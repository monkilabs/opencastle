---
name: turborepo-monorepo
description: "Configure pipelines, set up local/remote caching, and run scoped tasks in a Turborepo monorepo. Use when you say: 'enable remote caching', 'optimize pipeline inputs/outputs', or 'filter builds to affected packages'."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Turborepo Monorepo

## Commands

### Running Tasks

```bash
turbo run build                    # Build all packages
turbo run test                     # Test all packages
turbo run lint                     # Lint all packages
turbo run build --filter=web       # Build specific package
turbo run build --filter=./apps/*  # Build all apps
turbo run build --filter=...[HEAD~1]  # Only affected since last commit
```

### Common Patterns

```bash
turbo run build test lint          # Run multiple tasks
turbo run build --dry-run          # Preview what would run
turbo run build --graph            # Visualize task graph
turbo run build --force            # Ignore cache, rebuild all
turbo run build --concurrency=4    # Limit parallelism
```

### Forbidden Commands

```bash
# NEVER use these directly — always go through turbo:
npm run build      # Skips caching and parallelism
cd apps/web && npm test  # Skips dependency resolution
```

## Pipeline Configuration (turbo.json)

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "inputs": ["src/**", "test/**"]
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

### Key Concepts

- `^build` — run `build` in dependencies first (topological)
- `dependsOn` — declare task dependencies
- `outputs` — files to cache (miss = rebuild)
- `inputs` — files to hash for cache key (default: all tracked files)
- `cache: false` — never cache (use for `dev`, `start`)
- `persistent: true` — long-running tasks (dev servers)

## Caching

### Local Cache

Turborepo caches task outputs automatically in `node_modules/.cache/turbo`. Cache keys are computed from:

1. Task inputs (source files)
2. Environment variables
3. Dependencies' build outputs
4. `turbo.json` configuration

### Remote Cache

```bash
turbo login                        # Authenticate
turbo link                         # Link project to remote cache
turbo run build --remote-only      # Force remote cache usage
```

- Shares cache across CI and team members
- Vercel Remote Cache or self-hosted (Ducktape, TurboCache)
- Set `TURBO_TOKEN` and `TURBO_TEAM` in CI environment

## Quick Workflow: Setup remote caching in CI
1. Add `TURBO_TOKEN` and `TURBO_TEAM` to your CI secrets.  
2. Locally run `turbo login` and `turbo link` to verify the project is linked.  
3. Add `turbo run build --remote` to the CI pipeline and watch for cache hit/miss logs.  
4. If cache misses persist: verify `inputs`/`outputs` in `turbo.json`, stable env vars, then re-run.  

**Validation (recommended):** run `turbo run build --dry-run` locally or in CI to preview the task graph and catch misconfigured inputs/outputs before executing.


## Package Workspace Structure

```
monorepo/
├── turbo.json
├── package.json              # Root workspace config
├── apps/
│   ├── web/                  # Next.js app
│   └── docs/                 # Documentation site
├── packages/
│   ├── ui/                   # Shared UI components
│   ├── config/               # Shared config (ESLint, TS)
│   └── utils/                # Shared utilities
```

## Best Practices

- Always use `turbo run` instead of directly invoking package scripts
- Define `outputs` for every cacheable task — missing outputs mean missing cache
- Use `--filter` to scope commands to affected packages
- Set `inputs` to narrow cache keys and avoid unnecessary rebuilds
- Use `--dry-run` to debug pipeline configuration
- Add `TURBO_TOKEN` and `TURBO_TEAM` to CI for remote caching
- Never commit `.turbo/` or `node_modules/.cache/turbo`

