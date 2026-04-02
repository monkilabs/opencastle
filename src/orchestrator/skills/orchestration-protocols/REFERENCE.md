> Parent: [SKILL.md](./SKILL.md)

## Agent Health Monitoring

### Health Signals

| Signal | Threshold | Recovery |
|--------|-----------|----------|
| **Stuck** — no output/changes | Sub: 5 min / BG: 15 min | Nudge; if frozen, abort + re-delegate with simpler scope |
| **Looping** — same error repeated | 3 consecutive failures | Abort; add context; re-delegate with explicit fix path |
| **Scope creep** — files outside partition | Any | Redirect: "Only modify files in [partition]. Revert [file]." |
| **Context exhaustion** — confused/repetitive | Visible instruction amnesia | Checkpoint, end session, resume in fresh context |
| **Permission loop** — waiting for input | 2+ prompts without progress | Auto-approve if safe; abort + re-delegate |

**Cadence:** Sub-agents — continuous (real-time). Background agents — check at 10 min, then every 10 min. Always review full diff before accepting.

### Escalation Path

1. **Failure 1:** Re-delegate with more specific prompt + error context
2. **Failure 2:** Downscope (split into smaller pieces), re-delegate
3. **Failure 3:** Log to `.opencastle/AGENT-FAILURES.md`; if 3× panel BLOCK or conflict, create dispute in `.opencastle/DISPUTES.md` (see **team-lead-reference** § Dispute Protocol)

## Error Recovery Playbook

| Failure | Symptom | Recovery |
|---------|---------|----------|
| **Retry loop** | Same command fails 3+ times | Abort; identify root cause; re-delegate with explicit fix; log lesson |
| **MCP unavailable** | Tool connection/timeout errors | Check server; retry once; fall back to CLI; log to DLQ if critical |
| **Broken BG output** | Lint/type/test errors on return | Fix inline if small; discard + re-delegate if fundamental; DLQ after 2 fails |
| **Parallel merge conflict** | Two agents modified overlapping files | Accept complex side first; re-delegate simple side to adapt; log lesson |
| **Context exhausted** | Confused/repetitive responses | Checkpoint; end session; resume with checkpoint; reduce parallel work |
| **Post-merge test failure** | Tests pass alone but fail merged | Run affected tests; check import/state conflicts; delegate fix to likely cause |

## Agent Circuit Breaker

| Threshold | Action |
|-----------|--------|
| **2 failures** | Investigate: same error class? Model healthy? Prompt pattern? |
| **3 failures** | Open circuit — stop delegating; reassign or escalate to user |
| **Next session** | Half-open — resets; re-open + add lesson if fails again |

Judgment-based, not a hard gate. 3 similar failures with the same error is more concerning than 3 unrelated failures.
