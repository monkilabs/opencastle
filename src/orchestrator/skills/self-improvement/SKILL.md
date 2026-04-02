---
name: self-improvement
description: "Appends new entries to LESSONS-LEARNED.md via the opencastle lesson CLI, searches past lessons for matching errors, and proposes skill updates when retry patterns exceed thresholds. Use when consulting or updating LESSONS-LEARNED.md, after task failures, when capturing retrospective insights, or when a retry succeeds."
---

# Self-Improvement Protocol

## Core Rule

**Retry with a different approach and it works → document the lesson immediately.** File: `.opencastle/LESSONS-LEARNED.md`

## Writing a Lesson

> **⛔ HARD GATE — Use the CLI. Do NOT edit LESSONS-LEARNED.md directly.**

```sh
opencastle lesson --title "Short descriptive title" --category general --severity high \
  --problem "What was observed" --wrong "Failing approach" --correct "Working solution" \
  --why "Root cause"
```

Required: `--title`, `--category`, `--severity`, `--problem` · Optional: `--wrong`, `--correct`, `--why`

After writing: if the lesson reveals a gap in a skill/instruction file, update that file too (prevents the pitfall at source).

## Workflow

1. Search LESSONS-LEARNED.md for matching entries or similar errors.
2. Attempt the task with conservative flags/options informed by lessons.
3. On failure: retry with modified approach (up to threshold), capture error details and context.
4. On success: run `opencastle lesson` to record the working approach.
5. Verify: `tail -1 .opencastle/LESSONS-LEARNED.md` — confirm entry has title, category, and severity. If malformed → re-run with corrected flags.
6. If the lesson indicates a needed skill/instruction update: draft that change and propose a PR.

Quick search example:

```bash
rg "missing CRON_SECRET" .opencastle/LESSONS-LEARNED.md || true
```

## Categories & Severity

Category and severity tables moved to [LESSON-CATEGORIES.md](LESSON-CATEGORIES.md). Use that file when tagging lessons.

## Quality Rules

- Include exact error messages, commands, and tool parameters
- Show wrong **and** correct approaches — the contrast is actionable
- Explain why (root cause)
- One lesson per entry; code blocks mandatory for commands

## Anti-Patterns

Never skip reading lessons · Never fix without documenting · Never write vague entries · Never duplicate · Never defer to end of session

## Agent Memory

For expertise tracking and cross-session knowledge graphs, load the **agent-memory** skill.
