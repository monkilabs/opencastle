---
description: 'Scaffold a new skill file with proper frontmatter, structure, and registration. Use when adding a new domain skill to the AI configuration.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Create Skill

Scaffold a new skill for the AI agent configuration. Skills encode domain-specific knowledge that agents load on demand.

## Skill Request

{{skillDescription}}

---

## Skill Types

OpenCastle has two kinds of skills with different locations and registration paths:

| Type | Location | Bound Via | Purpose |
|------|----------|-----------|---------|
| **Process skill** | `skills/<name>/SKILL.md` | `directSkills` in skill-matrix.json | Stack-agnostic methodology (testing workflow, self-improvement, validation gates) |
| **Plugin skill** | `plugins/<plugin>/SKILL.md` | Capability slot in the skill matrix | Technology-specific knowledge (CMS queries, database patterns, deployment config) |

> **Rule of thumb:** If the skill would need to be rewritten when switching technologies (e.g., Supabase → Convex), it belongs in a **plugin**. If it's useful regardless of stack, it's a **process skill**.

---

## Workflow

### Step 1: Classify the Skill

Determine the type:

| Question | If Yes → | If No → |
|----------|----------|---------|
| Is this tied to a specific technology/tool? | Plugin skill | Process skill |
| Would switching tech stacks invalidate this content? | Plugin skill | Process skill |
| Does a plugin already exist for this tool in `plugins/`? | Add `SKILL.md` to existing plugin | Create new plugin or process skill |

### Step 2: Name the Skill

- Use `kebab-case`
- **Process skills:** descriptive domain name (e.g., `testing-workflow`, `context-map`, `security-hardening`)
- **Plugin skills:** `skillName` field in the plugin's `config.ts` (e.g., `sanity-cms`, `supabase-database`, `nx-workspace`)
- Check existing skills in `skills/` and `plugins/` to avoid overlap

### Step 3: Create the Skill File

**Process skill:** Create `skills/<skill-name>/SKILL.md`
**Plugin skill:** Create `plugins/<plugin-name>/SKILL.md`

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

If the skill has large code examples (>30 lines), schema tables, or verbose reference material, create a companion `REFERENCE.md` in the same directory and link to it from SKILL.md. Keep SKILL.md as the lean operational overview. Companion files must start with a backlink: `> Parent: [SKILL.md](./SKILL.md)`.

### Step 4: Register the Skill

Registration differs by type:

#### Process Skill

1. **Add to the skill matrix** — Add the skill name to the `directSkills` array of each relevant agent in `.opencastle/agents/skill-matrix.json`
2. **Optional: reference in instructions** — If the skill should be loaded by default, add it to the appropriate `.github/instructions/` file

#### Plugin Skill

1. **Set `skillName` in the plugin's `config.ts`** — This connects the skill to the plugin
2. **Update the skill matrix** — Add an entry to the matching capability slot's `entries` array in `.opencastle/agents/skill-matrix.json`
3. **No agent changes needed** — Agents resolve plugin skills through capability slots automatically

### Step 5: Validate

- [ ] File created at the correct path (`skills/` or `plugins/`)
- [ ] Frontmatter has `name` and `description` fields
- [ ] Description is a single line (no line breaks)
- [ ] Content follows the template structure
- [ ] No overlap with existing skills
- [ ] Skill matrix updated (`directSkills` array or capability slot binding)
- [ ] For process skills: at least one agent's `directSkills` array includes it in skill-matrix.json
- [ ] For plugin skills: `config.ts` `skillName` matches the `name` in frontmatter
- [ ] Run `npx tessl skill review <path>` — target 100 score (see Scoring Criteria below)

## Scoring Criteria

Skills are evaluated by `npx tessl skill review` across 8 criteria (3 pts each = 24 total). Target 100.

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
- **Don't explain what Claude knows** — Skip "what is X" explanations, obvious anti-pattern justifications, and concept definitions. Jump straight to the rules
- **Avoid duplication** — If a rule exists in another skill or instruction file, reference it: "Load **security-hardening** skill for CSP configuration"
- **Use REFERENCE.md for bulk** — Large code examples, schema tables, worked examples, and template libraries go in a companion `REFERENCE.md`. Link once from SKILL.md
- **Stay stack-agnostic in process skills** — Use capability slot references ("the **database** skill" not "Supabase")
- **Size target** — 80-200 lines in SKILL.md. Under 80 is too thin; over 200 should split content to REFERENCE.md. Over 300 should be split into multiple skills
- **No standalone trigger-term sections** — Weave trigger terms naturally into the description's `Use when...` clause
- **Third-person voice in descriptions** — "Creates X" not "Create X" or "This skill creates X"
