## Agent Health Monitoring

### Health Signals

| Signal | Observable | Recovery |
|--------|-----------|----------|
| **Stuck** — no progress | No new tool call, file change or output between two checks | Nudge; if frozen, abort + re-delegate with simpler scope |
| **Looping** — same error repeated | The same failing command or error 3 times in a row | Abort; add context; re-delegate with explicit fix path |
| **Scope creep** — files outside partition | Any | Redirect: "Only modify files in [partition]. Revert [file]." |
| **Context exhaustion** — confused/repetitive | Visible instruction amnesia | Checkpoint, end session, resume in fresh context |
| **Permission loop** — waiting for input | 2+ prompts without progress | Auto-approve if safe; abort + re-delegate |

**Cadence:** Sub-agents — every tool result. Background agents — whenever the assistant reports progress or completion, and `opencastle convoy` for convoy runs. Always review full diff before accepting.

### Escalation Path

Review failures (fast-review FAIL, panel BLOCK) follow the **fast-review** Handle Verdict table. Tool or runtime failures (crash, timeout, MCP down, empty output): retry once with more context, downscoped if needed; after the 2nd failed attempt log to `.opencastle/AGENT-FAILURES.md`.

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

Judgment-based, not a hard gate — 3 failures sharing one error class outweigh 3 unrelated ones.
