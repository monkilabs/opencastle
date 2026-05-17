---
name: self-improvement
description: "Appends new entries to LESSONS-LEARNED.md via opencastle lesson CLI; searches past lessons for matching errors; proposes skill updates when retry patterns exceed thresholds. Use when consulting or updating LESSONS-LEARNED.md, after task failures, when capturing retrospective insights, or when a retry succeeds."
---

# Self-Improvement Protocol

## Core Rule

**Retry with different approach and it works → document lesson immediately.** File: `.opencastle/LESSONS-LEARNED.md`

## Writing a Lesson

> **⛔ HARD GATE — Use the CLI. Do NOT edit LESSONS-LEARNED.md directly.**

```sh
opencastle lesson --title "Short descriptive title" --category general --severity high \
  --problem "What was observed" --wrong "Failing approach" --correct "Working solution" \
  --why "Root cause"
```

Required: `--title`, `--category`, `--severity`, `--problem` · Optional: `--wrong`, `--correct`, `--why`

After writing: if lesson reveals gap in skill/instruction file, update that file too (prevents pitfall at source).

## Workflow

1. Search LESSONS-LEARNED.md for matching entries or similar errors.
2. Attempt task with conservative flags/options informed by lessons.
3. On failure: retry with modified approach (up to threshold); capture error details, context.
4. On success: run `opencastle lesson` to record working approach.
5. Verify: `tail -1 .opencastle/LESSONS-LEARNED.md` — confirm entry has title, category, severity. If malformed → re-run with corrected flags.
6. If lesson indicates needed skill/instruction update: draft change; propose a PR.

Quick search example:

```bash
rg "missing CRON_SECRET" .opencastle/LESSONS-LEARNED.md || true
```

## Categories & Severity

Category, severity tables moved to [LESSON-CATEGORIES.md](LESSON-CATEGORIES.md). Use that file when tagging lessons.

## Quality Rules

- Include exact error messages, commands, tool parameters
- Show wrong **and** correct approaches — the contrast is actionable
- Explain why (root cause)
- One lesson per entry; code blocks mandatory for commands

## Anti-Patterns

Never skip reading lessons · Never fix without documenting · Never write vague entries · Never duplicate · Never defer to end of session

## Agent Memory

For expertise tracking, cross-session knowledge graphs, load **agent-memory** skill.
