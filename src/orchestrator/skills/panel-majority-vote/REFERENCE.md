> Parent: [SKILL.md](./SKILL.md)

## Panel — Weighted Consensus Variant (Reference)

Use this reference when a simple head-count majority is insufficient and domain expertise must influence the verdict.

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

Example: Security Expert + high = 4; Architect + med = 2.

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

### Report Extension (template)

```markdown
### Weighting
| Reviewer | Role | Domain | Confidence | Prior Success | Final Weight |
|----------|------|--------|------------|---------------|-------------|
| 1 | [Agent] | +X | +X | +X | X |

### Weighted Score
- PASS: X (reviewers: ...)
- BLOCK: X (reviewers: ...)
- **Overall: PASS/BLOCK** (weighted)
```

Last Updated: 2026-03-31
