---
description: 'Size the work in a PRD, score each workstream, and say whether to plan it in one go or as groups planned side by side. Returns JSON.'
agent: 'Reviewer'
output: json
---

# Assess PRD Complexity

Analyze the PRD at the end of this prompt — or, before a PRD exists, the request itself — and answer with a **single JSON object**.

## What Happens to Your Answer

`opencastle convoy` runs this step first on the request:

- `"complexity": "low"` with `"recommended_strategy": "single"` means the plan is written straight from the request, with no PRD. Answer `low` only when one or two agents can do the whole change in a session each.
- Otherwise a PRD is written, and your answer is used for it, unless you recommend `"chain"`: then the PRD is sized again, beside its review, so the groups can name its phases.

What the answer drives:

- The `task_complexity` scores go to the planner, which uses them to set each task's timeout, retries and review level.
- With `"recommended_strategy": "chain"` and groups that pass the checks below, each group is planned in a session of its own, all at the same time, each seeing only its own phases of the PRD. The plans are then joined into one spec: a group's first tasks wait for the last tasks of every group in its `depends_on`, and groups that do not depend on each other run side by side.
- Otherwise — `"single"`, or groups that fail the checks — the whole PRD is planned in one session.
- Your answer is cached against the PRD's exact text, so an unchanged PRD is not assessed twice.

The group checks: at most 3 groups when `total_tasks` is 15 or fewer, at most 4 above that; every group has at least one phase; no phase is in two groups; `depends_on` names only groups in the list; no cycles; names are kebab-case.

This session is read-only; answer in text.

## Output Rules

**CRITICAL:** Return ONLY a single fenced JSON block — no prose, no explanation, no headings. Start with the opening fence and end with the closing fence.

## Required JSON Schema

```json
{
  "original_prompt": "<string>",
  "total_tasks": <number>,
  "total_phases": <number>,
  "domains": ["<string>", ...],
  "estimated_duration_minutes": <number>,
  "complexity": "low" | "medium" | "high",
  "recommended_strategy": "single" | "chain",
  "chain_rationale": "<string — empty when strategy is single>",
  "convoy_groups": [
    {
      "name": "<kebab-case-name>",
      "description": "<one sentence>",
      "phases": [<phase numbers>],
      "depends_on": ["<group name>", ...]
    }
  ],
  "task_complexity": [
    {
      "workstream": "<workstream title from PRD Task Breakdown>",
      "phase": <phase number>,
      "complexity": 1 | 2 | 3 | 5 | 8 | 13,
      "rationale": "<brief reason>"
    }
  ]
}
```

## Field Rules

- `original_prompt`: The user's request, copied verbatim from "Original User Prompt" below. If that section is empty, a one-sentence summary of the PRD's Overview.
- `total_tasks`: Number of workstreams in the Task Breakdown.
- `total_phases`: Number of phases in the Task Breakdown.
- `domains`: Technical domains involved (e.g. "frontend", "api", "database", "testing", "config").
- `estimated_duration_minutes`: A rough estimate for AI agents doing the work, not people.
- `complexity`: `"low"` (1–4 workstreams), `"medium"` (5–8), `"high"` (9+).
- `recommended_strategy`:
  - `"single"` when: 8 or fewer workstreams, OR 3 or fewer phases, OR the workstreams share files heavily across phases.
  - `"chain"` when: more than 8 workstreams AND more than 3 phases AND the work splits along real domain boundaries — so the groups can be planned in parallel, each from a smaller part of the PRD.
- `chain_rationale`: Only for `"chain"` — why splitting helps this feature.
- `convoy_groups`:
  - For `"single"`: exactly one group covering every phase.
  - For `"chain"`: 2–4 groups. Use `depends_on` only where a group really needs another's output — groups without it run side by side.
  - **At least 3 workstreams per group.** Merge a smaller group into a neighbour.
  - **Do not map phases 1:1 to groups.** Bundle related phases (e.g. config + data in one group, components + pages in another). Split only at real domain boundaries.
- `task_complexity`: One entry per workstream, on a Fibonacci scale.
  - `workstream`: The workstream's exact title from the Task Breakdown.
  - `phase`: The phase it belongs to.
  - `complexity`: `1` (trivial — one file), `2` (simple — small fix, one test), `3` (moderate — new component or endpoint), `5` (significant — multi-file feature), `8` (complex — cross-cutting), `13` (epic — architecture-level).
  - `rationale`: One sentence explaining the score.

---

## PRD to Analyze

{{goal}}

## Original User Prompt

{{context}}
