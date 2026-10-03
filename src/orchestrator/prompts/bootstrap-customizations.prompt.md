---
description: 'Deep-analyze project to complete .opencastle/ configuration with schema details, API routes, environment variables, other info requiring reading actual config files. Programmatic bootstrap (run during opencastle init) already populated deterministic parts — do not redo that work.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Complete Project Customizations

Complete AI agent framework setup for a new project. Programmatic bootstrap (run automatically during `opencastle init`) already populated `.opencastle/` configuration files with everything it could determine automatically. Your job: **deep-analyze** project — reading actual config files, schemas, source code — to **fill in details** requiring reading real file contents.

## Additional Context (optional)

{{context}}

---

## Background

The `.opencastle/` directory holds project-specific configuration that skills load at runtime. Skills contain generic methodology (how to write migrations, how to test, how to deploy); customizations hold concrete values (which database, which endpoints, which project IDs).

Without customizations, agents operate blind — they don't know project's table schema, API routes, deployment target, task board. This prompt fixes that.

## Pre-Existing Setup

### `.opencastle/manifest.json` — Detection Data

`opencastle init` writes **`.opencastle/manifest.json`**. Two of its fields matter here:

1. **`repoInfo`** — what init detected by scanning config files, `package.json` dependencies, and directory structures
2. **`stack`** — the integrations installed: the ones init detected and the user confirmed, picked with `opencastle init --customize`, or added later with `opencastle add <pack>`

Example:

```json
{
  "stack": {
    "ides": ["vscode"],
    "techTools": ["nextjs", "supabase", "vitest", "chrome-devtools"],
    "teamTools": ["linear", "slack"]
  },
  "repoInfo": {
    "packageManager": "pnpm",
    "language": "typescript",
    "frameworks": ["next"],
    "databases": ["supabase"],
    "deployment": ["vercel"],
    "testing": ["vitest", "chrome-devtools"],
    "styling": ["tailwind"],
    "mcpConfig": true,
    "configFiles": ["package.json", "tsconfig.json", "vercel.json", "vitest.config.ts"]
  }
}
```

**Use `repoInfo` to:**
- Know which technologies are present — skip re-scanning, go straight to reading their config files
- Identify `configFiles` to read for deep inspection

**Use `stack` to:** know which integrations are installed. If `stack.teamTools` or `repoInfo.pm` names a tracker (`linear`, `jira`, `trello`), ensure `project/<tracker>-config.md` exists — init creates it only for a tracker it knew about at the time; one added later with `opencastle add` has none yet.

**Still inspect:** `repoInfo` detects presence, not configuration details. You still need to read the actual config files for schemas, IDs, routes, etc.

Skill matrix (`.opencastle/agents/skill-matrix.json`) already has `cms`, `database` binding entries pre-filled. Appropriate task management, notifications skills already installed. Verify correctness; fill in remaining empty bindings.

### Pre-populated `.opencastle/` Files — What's Already Done

Programmatic bootstrap running during `opencastle init` already created, partially filled these files. **Do not regenerate from scratch — update them instead.**

| File | What's already there | What's missing |
|------|---------------------|----------------|
| `project.instructions.md` | Tech stack table, project name/description, key commands (`build`, `test`, `lint`), monorepo workspace listing | Dev server ports, env var inventory, app-by-app purpose descriptions |
| `stack/testing-config.md` | Test framework names and config file paths | Selector conventions, test suite inventory, coverage thresholds, responsive breakpoints |
| `stack/deployment-config.md` | Deployment platforms and config file paths | Env var names, cron jobs, security headers, caching strategy |
| `stack/<provider>-config.md` | Database provider name and config file paths (e.g., `supabase-config.md`) | Table/schema inventory, RLS policies, auth integration details |
| `stack/<provider>-config.md` | CMS provider name and config file paths (e.g., `sanity-config.md`) | Content model inventory, query patterns, project IDs |
| `stack/api-config.md` | Framework name and empty endpoint tables (only when init detected a framework) | Route handler and Server Action inventory |
| `project/<tracker>-config.md` | Template (only when init knew about the tracker) | Team IDs, workflow states, labels |
| `project/docs-structure.md` | The `.opencastle/` documentation files | The project's own docs directory |
| `agents/agent-registry.md`, `agents/skill-matrix.json`, `agents/skill-matrix.md` | Agent tiers and skill bindings for the installed integrations | Nothing in most projects — verify bindings |
| `README.md`, `LESSONS-LEARNED.md`, `AGENT-FAILURES.md`, `AGENT-PERFORMANCE.md` | Full template content | Nothing — these are complete, just verify |
| `logs/README.md`, `logs/events.ndjson` | Schema docs + empty log file | Nothing — these are complete |

**Files that may not exist yet** (create them only if the project needs them):
- `stack/api-config.md` — if the project has API routes or Server Actions but init detected no framework
- `project/<tracker>-config.md` — if a tracker is in use but has no config file (see `stack` above)
- `stack/data-pipeline-config.md` — init never creates it; requires reading pipeline scripts

Any template file for technology NOT detected (no DB, no CMS, etc.) already removed.

## Workflow

### Phase 1: Discovery

Programmatic bootstrap already detected tech stack. **Skip re-scanning** — focus on reading actual file contents to extract details.

#### 1.1 Read Pre-populated Files

- **First**: Read all existing `.opencastle/` files to understand what's already filled in
- Read `.opencastle/project.instructions.md` to see current tech stack table, gaps
- Read each `stack/*.md` file — note any `<!-- TODO: verify -->` markers and empty table rows
- Read `.opencastle/manifest.json` for `repoInfo` and `configFiles` — use `configFiles` as your reading list
- Note what's missing (empty sections, placeholders, TODO markers)

#### 1.2 Deep Inspection

For each technology in pre-populated files, read its actual config files to extract details that couldn't be auto-detected:

- **Database**: Read migration files, schema definitions, RLS policies, auth setup — extract table names, column types, policy names
- **CMS**: Read schema files, document types, plugin config — extract content model names, field definitions, project/space IDs
- **API**: Read route handlers, Server Actions, middleware — extract HTTP methods, endpoint paths, external API integrations
- **Deployment**: Read deploy config — extract env var names (never values), cron schedules, security header values, cache settings
- **Testing**: Read test config and test files — extract selector conventions, coverage thresholds, test suite structure, responsive breakpoints
- **Docs**: Map the documentation directory tree (if it exists)
- **Task tracking**: Find team IDs, project IDs, workflow states (check Linear/Jira config or docs)

### Phase 2: Complete Customization Files

Update existing `.opencastle/` files using deep inspection data from Phase 1. **Do not regenerate files that already exist** — update them.

Target file structure for reference:

```
.opencastle/
├── README.md                  # Already created — verify
├── project.instructions.md    # Already created — complete missing sections
├── LESSONS-LEARNED.md         # Already created — verify
├── AGENT-FAILURES.md          # Already created — verify
├── AGENT-PERFORMANCE.md       # Already created — verify
├── agents/                    # Already created — verify
│   ├── agent-registry.md
│   ├── skill-matrix.json
│   └── skill-matrix.md
├── stack/                     # Partial — update existing, create missing
│   ├── api-config.md          # Complete, or create if the project has API routes and it is missing
│   ├── deployment-config.md   # Already created — complete missing sections
│   ├── testing-config.md      # Already created — complete missing sections
│   ├── <database>-config.md   # Already created — complete schema/RLS details
│   ├── <cms>-config.md        # Already created — complete content model details
│   └── data-pipeline-config.md  # Create if pipelines exist
├── project/                   # Partial — update existing, create missing
│   ├── docs-structure.md      # Already created — add the docs directory if one exists
│   └── <tracker>-config.md    # Complete, or create if a tracker is in use and it is missing
└── logs/                      # Already created — do not touch
    ├── README.md
    └── events.ndjson
```

#### Root Files — Verify Existing

1. **`README.md`** — Already exists. Verify it lists all generated files with accurate descriptions.

2. **`project.instructions.md`** — Already exists with tech stack table and key commands. **Complete**:
   - Fill in dev server ports and URLs (if missing)
   - Fill in app-by-app purpose descriptions
   - Add environment variable inventory (names only — never values)
   - Resolve any `<!-- TODO: verify -->` markers

3. **`LESSONS-LEARNED.md`**, **`AGENT-FAILURES.md`**, **`AGENT-PERFORMANCE.md`** — Already exist as templates. Verify they look correct — no changes needed.

#### `agents/` — Agent Framework Config (already created — verify)

`npx opencastle explain` lists the agents and skills compiled for this project, and where each assistant reads them.

4. **`agents/agent-registry.md`** — Already lists the agents with their tiers. **Complete**:
   - Scope descriptions for this project
   - File partition examples using this project's real paths

5. **`agents/skill-matrix.json`** — Already holds capability slot bindings and `directSkills` per agent. **Verify**:
   - Slot bindings point at skills that exist (`npx opencastle doctor` reports unresolved slots)
   - Which agents load which skills (slots for integration skills, `directSkills` for process skills)
   - Note: `skill-matrix.md` is companion documentation file — JSON is source of truth

#### `stack/` — Update Existing, Create Missing

6. **`stack/api-config.md`** — **Complete** it, or **create** it if the project has API routes or Server Actions and init did not:
   - Route handler inventory with HTTP methods
   - Server Actions inventory
   - External API integrations
   - Middleware chain
   - Authentication/authorization patterns

7. **`stack/deployment-config.md`** — Already exists. **Complete**:
   - Fill in environment variable names (never values)
   - Add cron jobs / scheduled tasks details
   - Add security headers
   - Add caching strategy
   - Resolve `<!-- TODO: verify -->` markers

8. **`stack/testing-config.md`** — Already exists. **Complete**:
   - Fill in test app/port for E2E
   - Add selector conventions (`data-testid`, etc.)
   - Add test suites inventory
   - Add coverage thresholds
   - Add responsive breakpoints for UI testing

9. **Database config** (e.g., `stack/supabase-config.md`, `stack/prisma-config.md`) — **Already exists**. **Complete**:
   - Fill in connection details (project ID, not credentials)
   - Add schema / table inventory with column summaries
   - Add role / permission system details
   - Add migration history and naming convention
   - Add auth integration flow
   - Resolve `<!-- TODO: verify -->` markers

10. **CMS config** (e.g., `stack/sanity-config.md`, `stack/contentful-config.md`) — **Already exists**. **Complete**:
    - Fill in project/space IDs
    - Add schema / content model inventory
    - Add plugin configuration
    - Add query patterns and examples
    - Resolve `<!-- TODO: verify -->` markers

11. **`stack/data-pipeline-config.md`** — **Create** if ETL / scraping / data processing exists:
    - Pipeline architecture
    - Data sources with status
    - CLI commands
    - Output format
    - Key files and directories

#### `project/` — Project Management Config (create missing files)

12. **`project/docs-structure.md`** — Already exists. **Complete** if the project has its own documentation directory:
    - Full directory tree
    - Purpose of each document
    - Documentation conventions

13. **Task tracker config** in `project/` (e.g., `project/linear-config.md`, `project/jira-config.md`) — **Complete** it, or **create** it if task tracking is in use and it is missing:
    - Team / project IDs
    - Workflow state IDs
    - Label / category IDs
    - Board conventions

#### `logs/` — Do Not Touch

`logs/README.md` and `logs/events.ndjson` are already created by the programmatic bootstrap. Do not modify them.

### Phase 3: Cross-Reference Verification

After generating all files:

1. **Check skill references** — For each skill `npx opencastle explain` lists, verify it references the correct customization file (or note if a reference needs to be added)
2. **Check for gaps** — Is there project-specific knowledge that doesn't fit any file? Create an appropriate new file
3. **Check for staleness** — Does the generated content match the current state of the code? Flag anything uncertain with `<!-- TODO: verify -->`

## Output Format

For each file **created or updated**, report:
- File path
- Whether it was created new or updated
- Key sections added or completed

End with a summary of what deep inspection revealed, what was completed/created, and what (if anything) still needs manual input (e.g., tracker team IDs that require API access to discover).

After your summary, suggest next steps:

### Suggested Next Steps

Now that your `.opencastle/` configuration is complete, here's what you can do:

1. **Review remaining TODOs** — Scan `.opencastle/` for any remaining `<!-- TODO: verify -->` comments and fill in missing values (e.g., tracker team IDs that require API access)
2. **Implement a feature** — Use the **"Implement Feature"** prompt (`/oc:implement-feature` in Claude Code and Copilot) to have the Team Lead orchestrate a full feature build with task tracking, delegation, and verification
3. **Fix a bug** — Use the **"Bug Fix"** prompt (`/oc:bug-fix`) for structured triage, root cause analysis, and fix with tracker tracking
4. **Brainstorm first** — Not sure how to approach something? Use the **"Brainstorm"** prompt (`/oc:brainstorm`) to explore requirements and trade-offs before committing to a plan
5. **Plan a larger change with the convoy engine (experimental)** — `npx opencastle convoy "<task>"` writes a PRD and a convoy spec to `.opencastle/convoys/<name>.convoy.yml`, then asks before running it

## Guidelines

- **Discover, don't assume.** Read actual config files. Don't guess that the project uses Supabase because it's a Next.js app.
- **Skip what doesn't exist.** If there's no CMS, don't create a CMS config file.
- **Names, not secrets.** Document environment variable names (`SUPABASE_URL`) but never values.
- **Be specific.** Write actual table names, actual endpoint paths, actual file paths — not placeholders.
- **Flag uncertainty.** If you can't determine something from the code, add a `<!-- TODO: verify -->` comment rather than guessing.
- **Keep files focused.** Each file covers one domain. Don't put database schema in the deployment config.
