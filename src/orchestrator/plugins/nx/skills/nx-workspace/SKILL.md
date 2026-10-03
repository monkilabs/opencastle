---
name: nx-workspace
description: "Run and generate NX targets, configure project.json, and visualize dependency graphs. Use when you say: 'run affected tests', 'nx generate a library', 'configure project.json', or 'show dependency graph'."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# NX Workspace

Docs: https://nx.dev/getting-started/intro. Project name → location mapping: `project.instructions.md`.

## Never bypass NX

```bash
# FORBIDDEN — skips caching, parallelism, and dependency resolution:
npm test | npm run test | npm run lint | npm run build | npm run dev | npm start
npx jest | npx eslint | jest --coverage | eslint --fix
```

Always `npx nx run <project>:<target>` for one project, `npx nx affected -t <target>` for multi-project changes.

## Requirements

- Minimum coverage **95%** for new components/functions. Reports land in `reports/coverage/jest/`.
- Lint always with `--fix`. CSS/SCSS uses a separate target: `npx nx run <project>:lint-styles --fix`.
- `npx nx run <project>:test -u` updates snapshots. `npx nx format --fix` after any generation.

## MCP tools — query, don't guess

| Tool | When |
|------|------|
| `nx_workspace` | First call — architecture and current errors |
| `nx_docs` | Any config question; check before assuming |
| `nx_project_details` | One project's targets, config, dependencies |
| `nx_visualize_graph` | Project/task dependency graph |
| `nx_generators` | List generators (plugin + local) |
| `nx_generator_schema` | Required options and defaults for one generator |
| `nx_available_plugins` | Only when no existing generator fits |
| `nx_current_running_tasks_details` | Running/completed/failed tasks |
| `nx_current_running_task_output` | Terminal output for one task |

## Generation

Prefer **local** generators over plugin generators — they encode repo conventions. Manual file creation is a last resort after `nx_generators` and `nx_available_plugins` both come up empty. Read `nx_generator_schema`, then read the generator source for side effects (config edits, dep installs).

```bash
npx nx generate <generator> <options> --dry-run --no-interactive   # preview
npx nx generate <generator> <options> --no-interactive
```

- **`--no-interactive` is mandatory** — prompts hang the run with no output.
- **Verify cwd first** — generators derive file placement from it.

After generating: `npx nx format --fix`, then lint/test/build the affected projects.

## Running tasks

Check `nx_current_running_tasks_details` before starting anything. **Continuous targets (`serve`, `dev`) are already running — read their output instead of re-running.** To rerun, use `npx nx run <taskId>` so NX context is preserved.
