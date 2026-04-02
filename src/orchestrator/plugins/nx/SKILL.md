---
name: nx-workspace
description: "Run and generate NX targets, configure project.json, and visualize dependency graphs. Use when you say: 'run affected tests', 'nx generate a library', 'configure project.json', or 'show dependency graph'."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# NX Workspace

## Commands

### Testing

```bash
yarn nx run <project-name>:test
yarn nx run <project-name>:test --coverage
yarn nx run <project-name>:test -u              # Update snapshots
yarn nx affected -t test                         # Affected tests only
```

### Linting

```bash
yarn nx run <project-name>:lint --fix
yarn nx run <project-name>:lint-styles --fix     # CSS/SCSS
yarn nx affected -t lint
```

### Building

```bash
yarn nx run <project-name>:build
yarn nx affected -t build
```

### Serving

```bash
yarn nx run <project-name>:serve
yarn nx run <project-name>:dev
```

### Code Generation

```bash
# Generate a library
yarn nx generate @nrwl/js:library ui --no-interactive
# Run affected builds/tests
yarn nx affected -t build
yarn nx affected -t test
```

### Formatting

```bash
yarn nx format --fix
```

### Forbidden Commands

```bash
# NEVER use these:
npm test | npm run test | npm run lint | npm run build
npm run dev | npm start | npx jest | npx eslint
jest --coverage | eslint --fix
```

## Requirements

- **Minimum Coverage**: 95% for new components/functions.
- **Coverage Reports**: `reports/coverage/jest/`.
- **Code Linting**: Always use `--fix` flag.
- **Style Linting**: `yarn nx run <project>:lint-styles --fix` for CSS/SCSS.

## Best Practices

1. Use `yarn nx run <project-name>:<target>` for explicit runs.
2. Use `yarn nx affected -t <target>` for multi-project changes.

## NX MCP Server

The NX MCP server provides tools for understanding and working with the workspace. Use these tools instead of guessing about workspace structure:

| Tool | When to Use |
|------|-------------|
| `nx_workspace` | First — understand workspace architecture, get errors |
| `nx_docs` | Configuration questions, best practices (always check before assuming) |
| `nx_project_details` | Inspect a specific project's targets, config, and dependencies |
| `nx_visualize_graph` | Visualize project/task dependency graphs |
| `nx_generators` | List available generators (plugin + local) |
| `nx_generator_schema` | Get schema details for a specific generator |
| `nx_available_plugins` | Discover installable plugins when no existing generator fits |
| `nx_current_running_tasks_details` | Monitor running/completed/failed tasks |
| `nx_current_running_task_output` | Get terminal output for a specific task |

---

## Code Generation Workflow

See [REFERENCE.md](REFERENCE.md) for generator schemas and `project.json` examples.

### Phase 1: Discover
1. List available generators using the `nx_generators` MCP tool (plugin + local workspace generators).
2. Prefer local generators over plugin generators — they're customized for this repo.
3. If no generator fits, check `nx_available_plugins`; only fall back to manual creation after exhausting all generator options.

### Phase 2: Understand

1. Fetch generator schema using `nx_generator_schema` — note required options, defaults, and file structure impacts
2. Read generator source to understand side effects (config updates, dep installs, files created/modified)
3. Examine existing similar artifacts for naming, structure, test runner, and config conventions; map user's request to generator options

### Phase 3: Execute

```bash
yarn nx generate <generator-name> <options> --dry-run --no-interactive  # optional preview
yarn nx generate <generator-name> <options> --no-interactive
```

**CRITICAL**: Always include `--no-interactive` to prevent prompts that hang execution.

**CRITICAL**: Verify cwd before running — generators may use it to determine file placement.

On failure: read the error, adjust options, and retry. Use the [self-improvement skill](../../skills/self-improvement/SKILL.md) for non-obvious fixes.

### Phase 4: Post-Generation

1. Modify generated code to match requirements (imports, exports, config, integrations)
2. Format: `yarn nx format --fix`
3. Verify lint, test, and build on generated/affected projects; fix small-scope issues directly, escalate large-scope failures

## Running Tasks Workflow

1. Use `nx_current_running_tasks_details` to check for active/completed/failed tasks
2. Use `nx_current_running_task_output` to get terminal output for a specific task
3. Diagnose issues from the output and apply fixes
4. To rerun, use `yarn nx run <taskId>` to preserve NX context
5. **Continuous tasks** (like `serve`) are already running — don't rerun, just check output

## Project Names

See `project.instructions.md` for the full project name → location mapping.
