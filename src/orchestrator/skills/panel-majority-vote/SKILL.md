---
name: panel-majority-vote
description: "Run 3 isolated reviewer sub-agents against the same question and decide PASS/BLOCK by majority vote (2/3 wins). Use when deterministic verification is insufficient."
---

# Skill: Panel majority vote

## Contract

| Rule | Detail |
|------|--------|
| Scope | One run root, one panel key |
| Artifacts | Reviewers use only declared in-scope artifacts |
| Runners | Exactly 3 isolated reviewer runs |
| Verdict | Majority (2/3 wins) |
| On BLOCK | Consolidated report must include retry summary |

## Inputs / Outputs

**Inputs:** `<runRoot>`, `<panelKey>` (filesystem-safe), question text, artifact list. Panel dir default: `<runRoot>/panel/`.

| File | Path |
|------|------|
| Prompt payload (optional) | `<panelDir>/<panelKey>-panel-prompt.md` |
| Raw reviewer outputs | `<panelDir>/<panelKey>-reviewer-outputs.md` |
| Consolidated report | `<panelDir>/<panelKey>.md` |

## Procedure

1. **Validate scope** — every artifact path is under `<runRoot>`; list is sufficient to answer the question.
2. **Spawn 3 reviewers in parallel** — identical prompt to 3 isolated subagents. Optionally write payload to `<panelDir>/<panelKey>-panel-prompt.md`. Required output sections (no others): `VERDICT: PASS | BLOCK`, `MUST-FIX:`, `SHOULD-FIX:`, `QUESTIONS:`, `TEST IDEAS:`, `CONFIDENCE: low | med | high`.
3. **Persist outputs** — write `<panelDir>/<panelKey>-reviewer-outputs.md` with header (run root, panel key, question, artifacts) and each reviewer output verbatim, separated.
4. **Consolidate** — count PASS/BLOCK; overall PASS if ≥ 2. Deduplicate MUST-FIX/SHOULD-FIX with reviewer counts. Record disagreements. Include determinize-next recs. If BLOCK, add retry summary.
5. **Write report** — create `<panelDir>/<panelKey>.md` using `panel-report.template.md`.
6. **Print summary** — overall verdict + vote tally + report path.
7. **Log (⛔ hard gate)** — use **observability-logging** skill panel command. Fields: `panel_key`, `verdict`, `pass_count`, `block_count`, `must_fix`, `should_fix`, `reviewer_model`, `weighted`, `attempt`, `tracker_issue`, `artifacts_count`, `report_path`. Link report as verification evidence.

## Notes

- On BLOCK: change the underlying work and re-run; do not re-word the question.
- After 3 consecutive BLOCKs on the same panel key: create a dispute record per **team-lead-reference** § Dispute Protocol.

## Model Selection

| Domain | Model |
|--------|-------|
| Security, architecture, complex logic | Quality (Claude Sonnet 4.6) × 3 |
| Feature implementation, UI, queries | Standard (Gemini 3.1 Pro) × 3 |
| Mixed-domain | Quality × 1, Standard × 2 |

Use same model for all 3 reviewers.

## Weighted Consensus Variant

For subjective decisions where domain expertise should weight more than head-count.

### When to Use

| Decision Type | Mode |
|--------------|------|
| Security vulnerability, code correctness | Simple majority |
| UI/UX, architecture tradeoffs, data model, naming | Weighted |

### Weight Assignment

Base weight: 1. Add bonuses:

| Factor | Bonus |
|--------|-------|
| Domain expertise (relevant to review) | +2 |
| Confidence high / med / low | +1 / 0 / -1 |
| Prior success rate >80% (AGENT-PERFORMANCE.md) | +1 |

Example: Security Expert + high = **4**; Architect + med = **2**.

### Voting Protocol

1. Assign weights before spawning.
2. Spawn with same prompt; collect PASS/BLOCK + confidence.
3. Score: sum weights by verdict; PASS if PASS score > BLOCK score.
4. Tie: highest individual weight breaks tie; if equal, default BLOCK.

### Conflict Resolution

| Scenario | Outcome |
|----------|---------|
| Low-weight BLOCKs, high-weight PASSes | PASS; move BLOCK's MUST-FIX → SHOULD-FIX |
| Domain expert BLOCKs, generalists PASS | BLOCK |
| All equal weight | Simple majority (2/3 wins) |

### Report Extension

```markdown
### Weighting
| Reviewer | Role | Domain | Confidence | Prior Success | Final Weight |
|----------|------|--------|------------|---------------|-------------|
| 1 | [Agent] | +X | +X | +X | X |

### Weighted Score
- PASS: X (reviewers: 1, 3)
- BLOCK: X (reviewer: 2)
- **Overall: PASS/BLOCK** (weighted)
```

### Integration

Same steps 1–7 as standard panel. Differences: assign weights in step 2; use weighted calculation in step 4; add weighting table to report. Team Lead decides simple vs. weighted; include rationale in delegation prompt.

