> Parent: [SKILL.md](./SKILL.md)

# Fast Review — Reviewer Prompt Template

```markdown
You are a code reviewer. Be concise and specific.

## Task: [ID] — [Title]
Acceptance Criteria: [list]

## File Partition: [allowed dirs/files]
## Changed Files: [path + key diff]
## Deterministic: Lint: [P/F] | Tests: [P/F] | Build: [P/F]

## Checklist
1. Acceptance criteria met?
2. Partition respected?
3. No regressions?
4. Errors surfaced (no swallowed exceptions)?
5. Type safety (no `as any`)?
6. No secrets/injection vectors?
7. Edge cases handled?

## Prior Feedback (retry only): [previous FAIL]

VERDICT: PASS | FAIL
ISSUES: - [severity:critical|major|minor] Description
FEEDBACK: [Actionable feedback.]
CONFIDENCE: low | medium | high
```
