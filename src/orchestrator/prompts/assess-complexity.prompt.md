---
description: 'Assess PRD complexity and recommend convoy strategy (single vs chain). Returns structured JSON consumed by the pipeline.'
agent: 'Reviewer'
output: json
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Assess PRD Complexity

Analyze the PRD below and produce a complexity assessment as a **single JSON object**. This JSON is consumed programmatically by the pipeline to decide whether to generate one convoy spec or a chain of convoy specs.

## PRD to Analyze

{{goal}}

## Original User Prompt

{{context}}

---

## Output Rules

**CRITICAL:** Return ONLY a single fenced JSON block — no prose, no explanation, no markdown headings. Start your response with the opening fence and end with the closing fence.

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

- `original_prompt`: Copy the user's original feature request verbatim from the "Original User Prompt" section above. If that section is empty, extract a one-sentence summary from the PRD's Overview section.
- `total_tasks`: Count of individual workstreams in the Task Breakdown.
- `total_phases`: Count of phases in the Task Breakdown.
- `domains`: List of technical domains involved (e.g., "frontend", "api", "database", "testing", "config").
- `estimated_duration_minutes`: Rough estimate assuming AI agent execution (not human).
- `complexity`: `"low"` (1–4 tasks), `"medium"` (5–8 tasks), `"high"` (9+ tasks).
- `recommended_strategy`:
  - `"single"` when: total tasks ≤ 8, OR total phases ≤ 3, OR all tasks are tightly coupled with heavy cross-phase file sharing.
  - `"chain"` when: total tasks > 8 AND total phases > 3 AND domains have natural boundaries — AND splitting improves failure isolation, observability, or retry granularity.
- `chain_rationale`: Only filled when `recommended_strategy` is `"chain"` — explain WHY splitting benefits this specific feature.
- `convoy_groups`:
  - When `"single"`: exactly one group covering all phases.
  - When `"chain"`: 2–4 groups with explicit `depends_on` order. Each group covers a coherent domain boundary.
  - **Minimum 3 tasks per group.** Never create a group that would produce a convoy with only 1–2 tasks — merge small groups with adjacent ones. A convoy with a single task is pointless overhead.
  - **Do NOT map phases 1:1 to groups.** Groups should bundle multiple related phases when tasks are tightly coupled (e.g., config + data in one group, components + pages in another). Only split at genuine domain boundaries where failure isolation matters.
  - Maximum 3 groups for projects with ≤ 15 tasks. Maximum 4 groups for 16+ tasks.
- `task_complexity`: Array of per-workstream complexity assessments using Fibonacci scale.
  - `workstream`: Exact workstream title from the PRD's Task Breakdown section.
  - `phase`: Phase number the workstream belongs to.
  - `complexity`: Fibonacci score: `1` (trivial — single file edit), `2` (simple — small fix, one test), `3` (moderate — new component/endpoint), `5` (significant — multi-file feature), `8` (complex — cross-cutting), `13` (epic — architecture-level).
  - `rationale`: One sentence explaining the score.
