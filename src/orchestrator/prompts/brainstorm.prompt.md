---
description: 'Collaborative brainstorm to explore requirements, approaches, trade-offs BEFORE committing to a plan. Use when task has ambiguity, multiple valid approaches, or significant design decisions.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Brainstorm

You are the Team Lead. Before planning or writing any code, run structured brainstorm to explore the request below. Goal: **surface assumptions, alternative approaches, trade-offs** before locking in a plan.

## Request

{{request}}

---

## Why Brainstorm?

Planning too early locks in assumptions. Brainstorm phase catches misunderstandings, reveals better approaches, aligns on scope — 10 minutes of thinking instead of hours of rework.

## Workflow

### 1. Clarify the Problem

Before exploring solutions, ensure problem is well-understood:

1. **Restate the request** in your own words — verify you understand what's being asked
2. **Identify the user's goals** — what outcome do they want? (not just what they asked for)
3. **Surface assumptions** — what are you assuming about scope, constraints, priorities?
4. **Ask clarifying questions** — if anything is ambiguous, ask now (max 3 questions, batch them)

### 2. Explore the Solution Space

Research before proposing. Gather data, don't guess:

1. **Search existing code** — is there already a partial implementation, similar pattern, or relevant utility?
2. **Check documentation** — read `.opencastle/project.instructions.md`, `.opencastle/project/decisions.md`, `.opencastle/KNOWN-ISSUES.md` for constraints
3. **Check lessons learned** — read `.opencastle/LESSONS-LEARNED.md` for pitfalls in this area
4. **Identify affected layers** — which apps, libs, data stores, third-party services are involved?
5. **Research unknown topics** — if the request involves a real-world person, place, organization, or topic you don't have confident knowledge about, **search the internet** using any available web search or fetch tools (e.g. `fetch_webpage`, web search MCP, or similar) to gather accurate facts. Never fabricate content about real-world subjects.

### 3. Generate Alternatives

Propose 2-3 approaches, not just the obvious one:

| Approach | Description | Pros | Cons | Effort |
|----------|-------------|------|------|--------|
| A | ... | ... | ... | S/M/L |
| B | ... | ... | ... | S/M/L |
| C | ... | ... | ... | S/M/L |

For each approach, consider:
- **Simplicity** — which is the boring, proven solution? (prefer this per Constitution #2)
- **Reversibility** — which is easiest to undo if wrong?
- **Impact on future work** — which makes next task easier or harder?
- **Risk** — which has the most unknowns?

### 4. Evaluate Trade-offs

Pick recommended approach; defend it:

1. **Why this approach?** — articulate key reason (1-2 sentences)
2. **What are we giving up?** — name trade-off explicitly
3. **What could go wrong?** — biggest risk + mitigation
4. **What's the exit strategy?** — if this approach fails, what's plan B?

### 5. Define Scope

Draw a clear boundary:

- **In scope:** What this task will deliver
- **Out of scope:** What it explicitly will NOT do (and why)
- **Deferred:** What could be done later as a follow-up

#### Design Direction (for multi-page projects)

If request involves building 2+ pages or UI sections, define design direction during brainstorming — not during implementation:

- **Aesthetic direction:** 2-3 words (e.g., "warm editorial", "clean minimal", "brutalist edge")
- **Typography pairing:** display font + body font (avoid generic defaults like Inter/Roboto)
- **Color intent:** dominant purpose, accent purpose, mood
- **Content tone:** formal/casual, active/passive, target audience voice
- **Key terminology:** terms that could be said multiple ways — pick one (e.g., "projects" not "portfolio")

Include this in Brainstorm Report so planning phase can inject into convoy foundation tasks.

### 6. Output

Summarize the brainstorm as **Brainstorm Report** — becomes input for planning/decomposition phase:

```markdown
## Brainstorm Report: [Title]

**Request:** One-sentence summary
**Recommended Approach:** [A/B/C] — [one-sentence rationale]
**Trade-off:** [what we're giving up]
**Risk:** [biggest risk + mitigation]

### Scope
- **In:** [list]
- **Out:** [list]
- **Deferred:** [list]

### Affected Areas
- Apps: [list]
- Libs: [list]
- Data: [which data layers are affected — see `project.instructions.md` for tech stack]
- Routes: [list]

### Open Questions
- [Any unresolved questions for the user]

### Design Direction (if multi-page)
- **Aesthetic:** [direction]
- **Typography:** [display font] + [body font]
- **Tone:** [description]
- **Key terms:** [glossary]
```

## When to Skip Brainstorming

Not every task needs brainstorm. Skip this prompt; go directly to `implement-feature` or `quick-refinement` when:

- The task is a well-defined bug with clear reproduction steps
- The task is a simple config change or docs update
- Technical approach is obvious and unambiguous
- The scope is a single file or component with no design decisions
- The task is well-understood and can be expressed as a convoy spec directly → use `generate-convoy` instead

## After Brainstorming

Once the brainstorm is complete and the user confirms (or you're confident in the approach):

1. **Transition to planning** — use the brainstorm report as input for `implement-feature` (which will choose between direct delegation and convoy execution based on task count)
2. **Preserve context** — include the brainstorm report in delegation prompts so agents understand *why* an approach was chosen
3. **Reference in tracker** — link the brainstorm findings in the tracker issue description
