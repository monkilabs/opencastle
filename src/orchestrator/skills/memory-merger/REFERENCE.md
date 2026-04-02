> Parent: [SKILL.md](./SKILL.md)

## Memory Merger Reference

### Worked Example: LES-042 — MCP Tool Timeout

**Lesson:** `LES-042: MCP tool timeout causes silent failures — always set explicit timeout and check return value` (cited 4×, severity high, 90 days old)

**Draft:**
```
Lesson: LES-042 — MCP tool timeout
Target: .github/skills/orchestration-protocols/SKILL.md
Section: Error Recovery Playbook
Edit: Add row: | **MCP timeout** | Tool returns null/undefined after delay | Set explicit timeout (30s); check return value; retry once; fall back to CLI; log to DLQ | <!-- Merged from LES-042 -->
```

**After merge in target file**, archive in LESSONS-LEARNED.md:
```markdown
### LES-042: MCP tool timeout → Merged to `.github/skills/orchestration-protocols/SKILL.md` on 2026-03-15
```
