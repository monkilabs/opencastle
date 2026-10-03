---
name: self-improvement
description: "Records lessons with the opencastle lesson CLI, one file each in .opencastle/lessons/; searches past lessons for matching errors; re-verifies lessons whose cited code changed; proposes skill updates when retry patterns exceed thresholds. Use when consulting or updating lessons, after task failures, when capturing retrospective insights, when a retry succeeds, or when doctor reports a lesson's citation changed."
---

# Self-Improvement Protocol

## Core Rule

**Retry with different approach and it works → record a lesson immediately.** Lessons live in `.opencastle/lessons/`, one Markdown file each; `.opencastle/LESSONS-LEARNED.md` is the index of them every agent reads first.

## Writing a Lesson

> **⛔ HARD GATE — Use the CLI. Never write in `LESSONS-LEARNED.md`: it is rewritten from `lessons/` by every sync.**

```sh
opencastle lesson --title "Short descriptive title" --category general --severity high \
  --problem "What was observed" --wrong "Failing approach" --correct "Working solution" \
  --why "Root cause" --cite src/lib/payments.ts:42
```

Required: `--title`, `--category`, `--severity`, `--problem` · Optional: `--wrong`, `--correct`, `--why`, `--cite` (repeatable)

`--cite` names the code the lesson is about, relative to the project root. When that code changes, `doctor` says the lesson may no longer hold — cite whenever the lesson is about a specific file.

The command prints the new lesson's id (`2026-10-02-short-descriptive-title`). It refuses a lesson that would commit a credential, and a citation that does not exist.

After writing: if the lesson reveals a gap in a skill or instruction file, update that file too (prevents the pitfall at source).

## Workflow

1. Search past lessons for matching entries or similar errors (below).
2. Attempt task with conservative flags/options informed by lessons.
3. On failure: retry with modified approach (up to threshold); capture error details, context.
4. On success: run `opencastle lesson` to record the working approach.
5. Verify: the command printed an id, and `.opencastle/lessons/<id>.md` holds the title, category and severity you gave. If malformed → fix the flags and run it again, then delete the bad file.
6. If the lesson indicates a needed skill/instruction update: draft the change; propose a PR.

Search the lessons themselves, not the index — the index has titles only:

```bash
rg -i "CRON_SECRET" .opencastle/lessons/ || true
```

## When code a lesson cites has changed

`doctor` names it: `<id> cites <file>, which has changed since it was verified`. Read the lesson against the code now:

| Still true? | Run |
|-------------|-----|
| Yes, file unchanged in substance | `opencastle lesson verify <id>` |
| Yes, but the code moved | `opencastle lesson verify <id> --cite <new/path.ts>` |
| No longer applies | `opencastle lesson archive <id> --into <file that now covers it>` |

## Categories & Severity

Valid `--category` and `--severity` values: [LESSON-CATEGORIES.md](LESSON-CATEGORIES.md).

## Quality Rules

- Include exact error messages, commands, tool parameters
- Always fill both `--wrong` and `--correct` — the contrast is what makes the lesson usable
- One lesson per command; code blocks mandatory for commands
- Never paste a token, key or password — describe it ("the Stripe test key in `.env`")

## Anti-Patterns

Never duplicate an existing lesson · Never defer recording to end of session · Never edit `LESSONS-LEARNED.md` by hand

## Agent Memory

For expertise tracking, cross-session knowledge graphs, load **agent-memory** skill.
