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

### `.opencastle.json` — Detection Data

The project root contains **`.opencastle.json`** with a `repoInfo` field populated by `opencastle init`. It merges two sources:

1. **Auto-detected tooling** — init command scanned config files, `package.json` dependencies, and directory structures
2. **User-declared choices** — user selected CMS, database, project management, notifications via interactive questionnaire

Result: single unified view of project's tech stack:

```json
{
  "repoInfo": {
    "packageManager": "pnpm",
    "monorepo": "nx",
    "language": "typescript",
    "frameworks": ["next", "astro"],
    "databases": ["prisma", "supabase"],
    "cms": ["sanity"],
    "deployment": ["vercel"],
    "testing": ["playwright", "vitest"],
    "cicd": ["github-actions"],
    "styling": ["css-modules", "tailwind"],
    "auth": ["next-auth", "supabase-auth"],
    "pm": ["linear"],
    "notifications": ["slack"],
    "mcpConfig": true,
    "configFiles": ["nx.json", "package.json", "tsconfig.json", "vercel.json"]
  },
  "stack": {
    "cms": "sanity",
    "db": "supabase",
    "pm": "linear",
    "notifications": "slack"
  }
}
```

**Use `repoInfo` to:**
- Know which technologies are present — skip re-scanning, go straight to reading their config files
- Identify `configFiles` to read for deep inspection
- Know which `project/` config files to create if missing (e.g., if `repoInfo.pm` includes `"linear"`, ensure `project/linear-config.md` exists)

**`stack` vs `repoInfo`:** The `stack` field holds the raw user questionnaire answers (used internally for MCP server filtering and skill selection). The `repoInfo` field is the combined view you should use — it includes everything from `stack` plus all auto-detected tooling.

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
| `README.md`, `LESSONS-LEARNED.md`, `AGENT-FAILURES.md`, `AGENT-PERFORMANCE.md` | Full template content | Nothing — these are complete, just verify |
| `logs/README.md`, `logs/events.ndjson` | Schema docs + empty log file | Nothing — these are complete |

**Files that DON'T exist yet** (because they can't be auto-populated and must be created by you):
- `stack/api-config.md` — requires reading actual route handlers and Server Actions
- `project/linear-config.md` (or other tracker) — requires reading docs or team IDs
- `project/docs-structure.md` — requires mapping the docs directory
- `stack/data-pipeline-config.md` — requires reading pipeline scripts
- `agents/agent-registry.md`, `agents/skill-matrix.json`, `agents/skill-matrix.md` — if `.github/agents/` and `.github/skills/` exist

Any template file for technology NOT detected (no DB, no CMS, etc.) already removed.

## Workflow

### Phase 1: Discovery

Programmatic bootstrap already detected tech stack. **Skip re-scanning** — focus on reading actual file contents to extract details.

#### 1.1 Read Pre-populated Files

- **First**: Read all existing `.opencastle/` files to understand what's already filled in
- Read `.opencastle/project.instructions.md` to see current tech stack table, gaps
- Read each `stack/*.md` file — note any `<!-- TODO: verify -->` markers and empty table rows
- Read `.opencastle.json` for `repoInfo` and `configFiles` — use `configFiles` as your reading list
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
├── agents/                    # Create if .github/agents/ and .github/skills/ exist
│   ├── agent-registry.md
│   ├── skill-matrix.json
│   └── skill-matrix.md
├── stack/                     # Partial — update existing, create missing
│   ├── api-config.md          # Create — cannot be auto-populated
│   ├── deployment-config.md   # Already created — complete missing sections
│   ├── testing-config.md      # Already created — complete missing sections
│   ├── <database>-config.md   # Already created — complete schema/RLS details
│   ├── <cms>-config.md        # Already created — complete content model details
│   └── data-pipeline-config.md  # Create if pipelines exist
├── project/                   # Create files that don't yet exist
│   ├── docs-structure.md      # Create if docs directory exists
│   └── <tracker>-config.md    # Create if task tracker configured
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

#### `agents/` — Agent Framework Config (create if `.github/agents/` exists)

4. **`agents/agent-registry.md`** — If `.github/agents/` exists with agent definitions:
   - List of agents with assigned model tiers
   - Scope descriptions
   - File partition examples

5. **`agents/skill-matrix.json`** — If `.github/skills/` exists with skill definitions:
   - Capability slot bindings and `directSkills` per agent role (in JSON format)
   - Which agents load which skills (slots for plugin skills, directSkills for process skills)
   - Note: `skill-matrix.md` is companion documentation file — JSON is source of truth

#### `stack/` — Update Existing, Create Missing

6. **`stack/api-config.md`** — **Create** (cannot be auto-populated). If the project has API routes or Server Actions:
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

12. **`project/docs-structure.md`** — **Create** if a documentation directory exists:
    - Full directory tree
    - Purpose of each document
    - Documentation conventions

13. **Task tracker config** in `project/` (e.g., `project/linear-config.md`, `project/jira-config.md`) — **Create** if task tracking is configured:
    - Team / project IDs
    - Workflow state IDs
    - Label / category IDs
    - Board conventions

#### `logs/` — Do Not Touch

`logs/README.md` and `logs/events.ndjson` are already created by the programmatic bootstrap. Do not modify them.

### Phase 3: Cross-Reference Verification

After generating all files:

1. **Check skill references** — For each skill in `.github/skills/`, verify it references the correct customization file (or note if a reference needs to be added)
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
2. **Implement a feature** — Use the **"Implement Feature"** prompt to have the Team Lead orchestrate a full feature build with task tracking, delegation, and verification
3. **Fix a bug** — Use the **"Bug Fix"** prompt for structured triage, root cause analysis, and fix with tracker tracking
4. **Brainstorm first** — Not sure how to approach something? Use the **"Brainstorm"** prompt to explore requirements and trade-offs before committing to a plan
5. **Generate a convoy spec** — Use the **"Generate Convoy"** prompt to create a `.convoy.yml` spec for autonomous convoy execution with `npx opencastle convoy --file <spec>` CLI command.

## Guidelines

- **Discover, don't assume.** Read actual config files. Don't guess that the project uses Supabase because it's a Next.js app.
- **Skip what doesn't exist.** If there's no CMS, don't create a CMS config file.
- **Names, not secrets.** Document environment variable names (`SUPABASE_URL`) but never values.
- **Be specific.** Write actual table names, actual endpoint paths, actual file paths — not placeholders.
- **Flag uncertainty.** If you can't determine something from the code, add a `<!-- TODO: verify -->` comment rather than guessing.
- **Keep files focused.** Each file covers one domain. Don't put database schema in the deployment config.
