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

Create `.opencastle/skills/<skill-name>/SKILL.md`.

Use this template:

```markdown
---
name: <skill-name>
description: "<Verb1> X, <verb2> Y, and <verb3> Z. Use when <scenario1>, <scenario2>, or <scenario3>."
---

# <Display Name>

## Workflow

1. **<Step>** — <Action>
   - Checkpoint: <what to verify before proceeding>
   - Recovery: <what to do on failure>
2. **<Step>** — <Action>
   - Checkpoint: <validation>
3. **<Step>** — <Action>
   - Fail → fix → re-run from step N.

## <Domain Section>

<Content organized by topic. Use tables, code blocks, and checklists.>

## <Executable Example>

```<lang>
// Concrete, copy-paste-ready code (5-15 lines)
```

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| <Bad pattern> | <What to do instead> |

## References

| Resource | Purpose |
|----------|--------|
| [REFERENCE.md](./REFERENCE.md) | <Extended examples, schemas, large tables> |
| **<related-skill>** skill | <What it contributes> |
```

If skill has large code examples (>30 lines), schema tables, or verbose reference material, create companion `REFERENCE.md` in same directory; link to it from SKILL.md. Keep SKILL.md as lean operational overview. Companion files must start with backlink: `> Parent: [SKILL.md](./SKILL.md)`.

### Step 4: Compile the Skill

1. **Run `npx opencastle sync`** — compiles the skill for every assistant in the project and adds it to each skill index. It reports `Compiled this project's own sources`.
2. **Optional: load it by default** — to have an agent load the skill for every task rather than when a task matches it, add the skill name to that agent's `directSkills` array in `.opencastle/agents/skill-matrix.json` (agents are keyed by display name, e.g. `"Developer"`). Sync keeps this edit.
3. **Commit** `.opencastle/skills/<skill-name>/` with the compiled files, so teammates get the skill on clone.

### Step 5: Validate

- [ ] File created at `.opencastle/skills/<skill-name>/SKILL.md`
- [ ] Frontmatter has `name` and `description` fields; `name` equals the directory name
- [ ] Description is single line (no line breaks)
- [ ] Content follows template structure
- [ ] No overlap with existing skills
- [ ] `npx opencastle sync --check` passes — the compiled copies match the source
- [ ] `npx opencastle doctor` passes — it checks that every script and path a team skill names exists
- [ ] Run `npx tessl skill review <path>` — target 100 score (see Scoring Criteria below)

## Scoring Criteria

Skills evaluated by `npx tessl skill review` across 8 criteria (3 pts each = 24 total). Target 100.

### Description (frontmatter `description` field)

| Criterion | 3/3 Pattern | Common Pitfall |
|-----------|------------|----------------|
| **Specificity** | List 3+ concrete actions as verbs: "Creates X, validates Y, and manages Z" | Vague "covers" or "handles" without listing what |
| **Trigger terms** | Natural phrases a user would say — broad synonyms and variations | Too specialized; missing common phrasings |
| **Completeness** | Explicit `Use when...` clause with 3+ trigger scenarios | Missing when-to-use guidance |
| **Distinctiveness** | Unique niche; terms unlikely to collide with other skills | Generic terms that overlap with adjacent skills |

**Formula:** `"<Verb1> X, <verb2> Y, and <verb3> Z. Use when <scenario1>, <scenario2>, or <scenario3>."`

### Content (SKILL.md body)

| Criterion | 3/3 Pattern | Common Pitfall |
|-----------|------------|----------------|
| **Conciseness** | Every line earns its place. No info Claude already knows. Tables over prose. | Explaining obvious concepts, redundant sections, verbose anti-patterns with "Why" columns |
| **Actionability** | ≥1 executable code example (copy-paste ready), concrete CLI commands, specific thresholds | Deferring to other skills without fallback, abstract guidance without examples |
| **Workflow clarity** | Numbered steps with validation checkpoints, explicit error recovery, feedback loops (fail → fix → re-run) | Implied sequence without numbers, no checkpoints between steps, missing recovery path |
| **Progressive disclosure** | SKILL.md = lean overview. Bulky content (>30-line examples, large tables, schemas) in REFERENCE.md. External refs organized in a References section. | Everything inline making the file too heavy, or too much deferred leaving SKILL.md hollow |

## Quality Guidelines

- **Be prescriptive** — "Use `fetchPlaces()` from `libs/queries`" beats "use the query library"
- **Include executable examples** — At least one copy-paste-ready code block (5-15 lines). CLI commands with real flags, not placeholders
- **Keep it scannable** — Tables over prose. Headings, bullets, code blocks. Agents parse structure, not paragraphs
- **Number your workflows** — Every multi-step process needs numbered steps, checkpoints ("Gate: X passes"), and recovery ("Fail → fix → re-run step N")
- **Don't explain what Claude knows** — Skip "what is X" explanations, obvious anti-pattern justifications, concept definitions. Jump straight to the rules
- **Avoid duplication** — If rule exists in another skill or instruction file, reference it: "Load **security-hardening** skill for CSP configuration"
- **Use REFERENCE.md for bulk** — Large code examples, schema tables, worked examples, template libraries go in companion `REFERENCE.md`. Link once from SKILL.md
- **Stay stack-agnostic in process skills** — Use capability slot references ("the **database** skill" not "Supabase")
- **Size target** — 80-200 lines in SKILL.md. Under 80 too thin; over 200 split content to REFERENCE.md. Over 300 split into multiple skills
- **No standalone trigger-term sections** — Weave trigger terms naturally into description's `Use when...` clause
- **Third-person voice in descriptions** — "Creates X" not "Create X" or "This skill creates X"
