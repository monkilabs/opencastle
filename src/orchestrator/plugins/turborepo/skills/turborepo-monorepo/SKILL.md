---
name: turborepo-monorepo
description: "Turborepo task pipelines, caching and package filtering. Use when editing turbo.json, running tasks for changed or filtered packages, or debugging cache misses and remote caching."
---

# Turborepo Monorepo

## Commands

```bash
turbo run build                       # Build all packages
turbo run build --filter=web          # One package
turbo run build --filter=./apps/*     # All apps
turbo run build test lint --affected  # Only packages changed vs the default branch (CI)
turbo run build --dry-run             # Preview what would run
turbo run build --graph               # Visualize task graph
turbo run build --force               # Ignore cache, rebuild all
```

Run tasks through `turbo run` (or a root script that wraps it). `cd apps/web && npm test` skips caching and dependency order.

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

- `^build` — run `build` in dependencies first (topological)
- `outputs` — files to cache; leave them out and a cache hit restores no files
- `inputs` — files hashed for the cache key (default: all tracked files in the package)
- `cache: false` + `persistent: true` — long-running tasks (dev servers)

## Caching

The local cache lives in `.turbo/cache` (Turborepo 2.0+). Keys hash task inputs, declared env vars, dependencies' outputs and `turbo.json`. An env var the build reads but `env` does not declare causes stale hits; one that changes every run causes constant misses.

Remote cache: `turbo login` and `turbo link` locally; in CI set `TURBO_TOKEN` and `TURBO_TEAM` and a plain `turbo run` reads and writes it. Persistent misses → check `inputs`/`outputs`/`env` in `turbo.json`, then compare runs with `--dry-run=json`.

Never commit `.turbo/`.
