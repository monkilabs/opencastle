---
description: 'Completes the .opencastle/ project files on an existing codebase: checks what opencastle init read from the code, and fills in the "Still to describe" list at the end of each file by reading the code.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Complete Project Customizations

`opencastle init` has already written `.opencastle/` from the repository: the stack with versions, the project structure, commands, routes and API endpoints, models and migrations, environment variable names, test setup, and which skill covers which part. What it could not read from the code, each file lists at its end under **Still to describe**. Your job is that list, and checking the rest.

## Additional Context (optional)

{{context}}

---

## What the skills read

| File | Holds | Read by |
|------|-------|---------|
| `.opencastle/project.instructions.md` | Stack, structure, commands, routes, environment, domain → skill map | Every session: compiled into what each assistant always loads |
| `.opencastle/stack/api-config.md` | Endpoints, server actions, middleware, external APIs | `api-patterns` |
| `.opencastle/stack/<database>-config.md` | Models, migrations, access rules | The database's skill |
| `.opencastle/stack/<cms>-config.md` | IDs, document types, queries | The CMS's skill |
| `.opencastle/stack/testing-config.md` | Test frameworks, files, browser checks, breakpoints | `testing-workflow`, `browser-testing` |
| `.opencastle/stack/deployment-config.md` | Platform, config, CI, environments | `deployment-infrastructure` and the platform's skill |
| `.opencastle/project/<tracker>-config.md` | Team and project IDs, workflow states, labels | The tracker's skill |
| `.opencastle/agents/agent-registry.md` | Which agent is for what; Deepen-Plan scopes | `team-lead-reference` |

`.opencastle/manifest.json` records what init detected (`repoInfo`) and the integrations installed (`stack`); `npx opencastle explain` lists the skills compiled for this project.

## Workflow

### 1. Read what is there

Read every file above that exists. Note each "Still to describe" item, and anything that looks wrong.

### 2. Check the facts

init reads files; it does not run the project. Fix what it got wrong — a directory purpose guessed from its name, a dev port that a config overrides, a route that is not one. Keep everything that is right as it is.

### 3. Fill in the lists

For each "Still to describe" item, read the code that answers it and write the answer into the file as a section of its own, then remove the item. When a list is empty, remove its heading too. Typical sources:

- **Architecture** — entry points, how the apps and packages depend on each other, what calls which external service.
- **Endpoint auth and limits** — middleware, the auth helpers each route handler calls, rate-limit config.
- **Models and access** — the schema's relations, row-level security policies, role checks in the code.
- **Selectors and test data** — existing tests, `data-testid` usage, fixtures and seed scripts.
- **Environments and releases** — deploy config, CI workflows, the README.

Where only a person can know the answer — a production URL, a team ID behind an API — leave the item and say so in your summary.

### 4. Add what is missing

- A tracker in use with no `project/<tracker>-config.md`: create it.
- An ETL, scraping or import pipeline: create `stack/data-pipeline-config.md` — sources, commands, output format, key files.
- In `agents/agent-registry.md`, keep the Deepen-Plan scopes to directories that exist.

### 5. Compile

Run `npx opencastle sync`. `project.instructions.md` is part of what every assistant always loads, and they get your changes only once it is compiled. The `stack/` and `project/` files are read when a skill needs them and need no sync.

## Rules

- **Discover, don't assume.** Read the files; a Next.js app does not imply Supabase.
- **Names, never values.** Environment variable names only; never read `.env`.
- **Specific.** Real table names, endpoint paths and file paths — no placeholders, no empty tables.
- **Short.** Every session loads `project.instructions.md` whole; write what an agent needs to act, not a tour of the code, and put detail in the `stack/` files.

## Output

For each file you changed: its path and what you added or corrected. Then what is still open and needs a person.

Then suggest next steps: `/oc:implement-feature` (or ask for the implement-feature prompt) for a feature, `/oc:bug-fix` for a bug, `/oc:brainstorm` to explore first, and `npx opencastle convoy "<task>"` (experimental) to plan larger work as tasks that run in parallel.
