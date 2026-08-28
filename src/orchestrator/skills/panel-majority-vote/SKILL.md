---
name: panel-majority-vote
description: "Runs 3 isolated reviewer sub-agents; consolidates PASS/BLOCK verdict by majority. Use when user requests independent review of code changes, pull requests, design documents, or release notes."
---

# Skill: Panel majority vote

## Inputs / Outputs

**Inputs:** `<runRoot>`, `<panelKey>` (filesystem-safe), question text, artifact list. Panel dir default: `<runRoot>/panel/`.

| File | Path |
|------|------|
| Prompt payload (optional) | `<panelDir>/<panelKey>-panel-prompt.md` |
| Raw reviewer outputs | `<panelDir>/<panelKey>-reviewer-outputs.md` |
| Consolidated report | `<panelDir>/<panelKey>.md` |


## Procedure

1. **Validate scope** — every artifact path under `<runRoot>`; list sufficient to answer question.

2. **Spawn 3 reviewers in parallel** — three sub-agent dispatches with identical prompts (same question, artifact list, constraints), each isolated. Required reviewer output sections (no others): `VERDICT: PASS | BLOCK`, `MUST-FIX:`, `SHOULD-FIX:`, `QUESTIONS:`, `TEST IDEAS:`, `CONFIDENCE: low | med | high`.

3. **Persist outputs** — write `<panelDir>/<panelKey>-reviewer-outputs.md` with a header (run root, panel key, question, artifacts) and each reviewer output verbatim, separated.

4. **Consolidate** — parse each reviewer output for its `VERDICT:` line and count PASS votes. Overall verdict = PASS if pass_count ≥ 2; otherwise BLOCK. Deduplicate `MUST-FIX:` and `SHOULD-FIX:` items and annotate each item with `(N/3 reviewers)`.

```bash
# count PASS/BLOCK from combined outputs
pass_count=$(grep -o "VERDICT: PASS" panel/run123-reviewer-outputs.md | wc -l)
block_count=$(grep -o "VERDICT: BLOCK" panel/run123-reviewer-outputs.md | wc -l)
verdict=$([ "$pass_count" -ge 2 ] && echo PASS || echo BLOCK)

# emit a minimal JSON summary using jq (install jq if needed)
jq -n --arg panel_key "run123-panel" --arg verdict "$verdict" --argjson pass_count $pass_count --argjson block_count $block_count '{panel_key:$panel_key, verdict:$verdict, pass_count:$pass_count, block_count:$block_count}' > panel/run123-summary.json
```

5. **Write report** — create `<panelDir>/<panelKey>.md` from [panel-report.template.md](./panel-report.template.md), referencing the generated summary. Minimal structure:

- Title: Panel `<panelKey>` — Verdict: `PASS | BLOCK` (pass_count/block_count)
- Highlights: top deduplicated `MUST-FIX` and `SHOULD-FIX` items
- Evidence: paths to reviewer outputs and `panel/run123-summary.json`

6. **Print summary** — overall verdict + vote tally + report path.

7. **Log (⛔ hard gate)** — call the **observability-logging** skill with `panel_key`, `verdict`, `pass_count`, `block_count`, `must_fix`, `should_fix`, `reviewer_model`, `weighted`, `attempt`, `tracker_issue`, `artifacts_count`, `report_path` for verification.

## Notes

- On BLOCK: change underlying work; re-run; do not re-word question.
- After 3 consecutive BLOCKs on the same panel key: create a dispute record per **team-lead-reference** § Dispute Protocol.
- Model selection: same model for all 3 reviewers. See **team-lead-reference** for model routing.
- Weighted consensus variant (domain-expertise weighting): see [REFERENCE.md](./REFERENCE.md).

