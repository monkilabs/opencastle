# Skill Matrix

Maps abstract technology capabilities to concrete skill implementations. The matrix distinguishes two types of skills:

- **Binding slots** — Plugin-driven, technology-specific skills resolved at runtime (e.g., `database` → `supabase-database`). These change when the tech stack changes.
- **Core skills** — Hardcoded, stack-agnostic skills referenced directly in agent files (e.g., `validation-gates`, `security-hardening`, `performance-optimization`). These are always available regardless of plugins.

## Data File

The machine-readable bindings are in [`skill-matrix.json`](skill-matrix.json). The CLI (`opencastle init` and `opencastle update`) reads and writes this file directly. Agents should read the JSON to resolve capability slots.

## How It Works

```
Agent file                  skill-matrix.json            Skill file
┌──────────────┐           ┌──────────────┐           ┌──────────────┐
│ Developer    │           │ "framework": │           │ nextjs-      │
│  needs:      │──lookup──▶│  entries: [  │──load────▶│ framework    │
│  framework   │           │   {name,     │           │              │
│              │           │    skill}    │           │              │
│              │           │  ]           │           │              │
└──────────────┘           └──────────────┘           └──────────────┘
```

1. **Agents** declare which capability slots they need (e.g., `framework`, `database`)
2. **`skill-matrix.json`** maps each slot to one or more technologies and their skill files
3. **When delegating**, resolve slots through the JSON to load the correct skill(s)
4. **To switch tech**, update only the binding entries — no agent files change

## Multiple Technologies Per Slot

A slot can have multiple entries. For example, a project using both Supabase and Prisma:

```json
"database": {
  "entries": [
    { "name": "Supabase", "skill": "supabase-database" },
    { "name": "Prisma", "skill": "prisma-database" }
  ],
  "description": "Schema, migrations, auth flow, roles"
}
```

When resolving, load **all** skills listed in the slot's entries.

## Switching Technologies

### Example: Migrate to a new plugin (Supabase → Azure)

1. Create (or install) the Azure plugin: `plugins/azure/SKILL.md` + `plugins/azure/config.ts`
2. Update `skill-matrix.json`: replace the database entries
3. Update `project.instructions.md` to reflect the new tech stack
4. **No agent files change** — Database Engineer, Security Expert still reference the `database` slot

### Example: Migrate to an existing plugin (Linear → Jira)

1. Plugin already exists: `plugins/jira/SKILL.md`
2. Update `skill-matrix.json`: replace the `task-management` entries
3. **No agent files change** — Team Lead still references the `task-management` slot

### Example: Switch knowledge-management tool (Notion → Confluence)

1. Create (or install) the Confluence plugin: `plugins/confluence/SKILL.md` + `plugins/confluence/config.ts`
2. Update `skill-matrix.json`: replace the `knowledge-management` entries
3. **No agent files change** — Team Lead, Researcher, Documentation Writer, and Architect still reference the `knowledge-management` slot

## Capability Slots Reference

| Slot | Description | Agents That Use It |
|------|-------------|-------------------|
| `framework` | SSR/SSG, routing, layouts | Developer, SEO Specialist, API Designer |
| `database` | Schema, migrations, auth flow | Database Engineer, Security Expert |
| `cms` | Document types, queries | Content Engineer, Copywriter, SEO Specialist |
| `deployment` | Hosting, cron, env vars | DevOps Expert, Release Manager |
| `codebase-tool` | Task running, linting, testing | Architect, Release Manager |
| `testing` | Unit testing frameworks | Testing Expert |
| `e2e-testing` | Browser automation | UI/UX Expert, Testing Expert |
| `task-management` | Issue tracking, workflow states | Team Lead |
| `knowledge-management` | Knowledge base, research, ADRs, specs | Team Lead, Researcher, Documentation Writer, Architect |
| `design` | Design tokens, component inspection, asset export | UI/UX Expert |
| `email` | Transactional email, templates, delivery | Developer |
| `payments` | Payment processing, subscriptions, webhooks | Developer |
| `observability` | Error tracking, performance monitoring, tracing | DevOps Expert, Performance Expert |
| `notifications` | Team messaging, alerts, bot integrations | Developer |

### Example: Add a second plugin

1. Update `skill-matrix.json`: add another entry to the `framework` slot
2. Both framework skills will be loaded when agents resolve the `framework` slot

## Missing Plugin or Empty Slot

When resolving a capability slot, two failure cases can occur:

1. **Empty slot** — The slot's `entries` array is empty (no plugin installed for that technology). Example: an agent needs `database` but no database plugin was selected during `opencastle init`.
2. **Missing plugin** — The slot references a skill name (e.g., `"skill": "convex-database"`) but no matching plugin `SKILL.md` file exists on disk.

In both cases, **tell the user** that the capability is unavailable and why:

- *"The `database` slot has no entries in `skill-matrix.json`. Install a database plugin (e.g., `supabase`, `prisma`) via `opencastle update`, or add entries manually."*
- *"The `database` slot references skill `convex-database`, but no matching plugin was found. Install the Convex plugin or run `opencastle update` to fix the binding."*

**Do NOT silently skip the slot or proceed without the skill.** The agent should surface the gap clearly so the user can resolve it.

## Design Principles

1. **Single source of truth** — All skill assignments (slots and direct) live in `skill-matrix.json`, not in agent files
2. **Agents are stack-agnostic** — They describe *what* they need, not *which* tool they use
3. **Swap without rewriting** — Changing entries updates every agent that uses that slot
4. **Process skills are stable** — Methodology doesn't change with technology; direct skill references in the matrix are fine
5. **Capability slots are composable** — Agents can combine slots and direct skills freely (e.g., Security Expert uses the `database` slot + `security-hardening` direct skill)
