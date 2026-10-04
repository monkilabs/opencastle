---
description: 'Scaffold new skill file with proper frontmatter, structure, registration. Use when adding new domain skill to AI configuration.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Create Skill

Scaffold new skill for AI agent configuration. Skills encode domain-specific knowledge agents load on demand.

## Skill Request

{{skillDescription}}

---

## Where Team Skills Live

A skill you create is a team skill: one source file, compiled for every assistant in the project.

| What | Where |
|------|-------|
| **The skill** | `.opencastle/skills/<name>/SKILL.md`, plus any companion files (e.g. `REFERENCE.md`) beside it |
| **Compiled copies** | Written by `npx opencastle sync` into each assistant's skill directory, and listed in each assistant's skill index — never edit them; the next sync replaces them |

Agents load a skill when a task matches its `description`, so the description is what makes it found.

> **Rule of thumb:** If skill would need rewriting when switching technologies (e.g., Supabase → Convex), it is **technology-specific**: name the technology in its name and description. If useful regardless of stack, it is a **process skill**: keep it stack-agnostic.

---

## Workflow

### Step 1: Check What Exists

| Question | If Yes → |
|----------|----------|
| Does a compiled skill already cover this? (`npx opencastle explain` lists every skill) | Improve it instead of adding a second one. A team skill with the same name as one of OpenCastle's replaces it for every assistant — copy the compiled `SKILL.md` into `.opencastle/skills/<name>/` and edit it there |
| Is it about a tool OpenCastle has an integration for? (`npx opencastle add --list`) | `npx opencastle add <pack>` installs that integration's skill; write a team skill only for what it lacks |
| Is it tied to a specific technology? | Technology-specific skill |
| Would switching tech stacks invalidate this content? | Technology-specific skill |

### Step 2: Name the Skill

- Use `kebab-case`; the directory name is the skill's name
- **Process skills:** descriptive domain name (e.g., `deploy-runbook`, `release-checklist`, `incident-triage`)
- **Technology-specific skills:** lead with the technology (e.g., `supabase-rls`, `stripe-webhooks`)
- Check `.opencastle/skills/` and `npx opencastle explain` to avoid overlap

### Step 3: Create the Skill File

Create `.opencastle/skills/<skill-name>/SKILL.md`. Load the **writing-for-agents** skill first; it holds the levers this step applies.

```markdown
---
name: <skill-name>
description: "<What the skill is for, in third person>. Use when <situation>, <situation> or <situation>."
---

# <Display Name>

<What an agent gets wrong without this skill: rules, gotchas, exact commands. Numbered steps where order matters, each ending on a check it can verify.>
```

**Description** — the pointer that decides when the skill loads:

- What the skill is for, then when to use it, in third person ("Checks…", "Use when…").
- One trigger per branch: each situation that should load it, named once, not a list of synonyms.
- No workflow summary: an agent that reads the steps in the description may follow them instead of the body.
- No "Trigger terms:" tail; fold the real triggers into the "Use when" sentence.
- One line, aim for 250 characters or fewer.

**Body** — as short as the knowledge allows, and under 500 lines. Material only some tasks need goes in a companion file beside `SKILL.md` (e.g. `REFERENCE.md`), linked from `SKILL.md` with the condition for reading it.

### Step 4: Compile the Skill

1. **Run `npx opencastle sync`** — compiles the skill for every assistant in the project and adds it to each skill index. It reports `Compiled this project's own sources`.
2. **Optional: load it by default** — to have an agent load the skill for every task rather than when a task matches it, add the skill name to that agent's `directSkills` array in `.opencastle/agents/skill-matrix.json` (agents are keyed by display name, e.g. `"Developer"`). Sync keeps this edit.
3. **Commit** `.opencastle/skills/<skill-name>/` with the compiled files, so teammates get the skill on clone.

### Step 5: Validate

- [ ] File created at `.opencastle/skills/<skill-name>/SKILL.md`
- [ ] Frontmatter has `name` and `description` fields; `name` equals the directory name
- [ ] Description is single line (no line breaks)
- [ ] No overlap with existing skills
- [ ] `npx opencastle sync --check` passes — the compiled copies match the source
- [ ] `npx opencastle doctor` passes — it checks that every script and path a team skill names exists
- [ ] Description follows the rules in Step 3

## Quality Guidelines

- **Be prescriptive** — "Use `fetchPlaces()` from `libs/queries`" beats "use the query library"
- **Exact commands** — CLI commands with real flags, not placeholders
- **Keep it scannable** — Tables over prose. Headings, bullets, code blocks. Agents parse structure, not paragraphs
- **Number your workflows** — Where order matters: numbered steps, each ending on a check, with the recovery on failure
- **Don't explain what Claude knows** — Skip "what is X" explanations, obvious anti-pattern justifications, concept definitions. Jump straight to the rules
- **Avoid duplication** — If rule exists in another skill or instruction file, reference it: "Load **security-hardening** skill for CSP configuration"
- **Stay stack-agnostic in process skills** — Use capability slot references ("the **database** skill" not "Supabase")
