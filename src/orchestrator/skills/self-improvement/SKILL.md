---
name: self-improvement
description: "Keeps the team's memory: decides whether what you learned belongs to the team or to the user, records the team's as lessons in .opencastle/lessons/ with npx opencastle lesson, and re-verifies and graduates them. Use when you confirm something true for anyone working in the repository (a fix after a failure, a convention, a decision, a quirk, a correction about the code), before work past lessons may cover, when doctor reports a lesson's cited code changed, or when the lessons index grows long."
---

# Self-Improvement

Lessons are the team's memory. A lesson is a file in `.opencastle/lessons/`, committed with the change you made, so the team reviews it in that pull request; `.opencastle/LESSONS-LEARNED.md` is the index every agent reads first, rewritten from those files by every sync — never edit it by hand.

## The team's or the user's

Decide when you learn it, not later. Nobody sorts memories afterwards.

| It is about | Where it goes | For example |
|-------------|---------------|-------------|
| The project: true for anyone working in this repository | A lesson, as soon as you have confirmed it | `pnpm build` fails without `CI=1` set; every migration ships with a down file; the staging API allows 10 requests a second; the user says "we never use default exports" |
| The user: true for them, wherever they work | Your own memory, never a lesson | They want short answers; they use fish; their role; their editor; paths on their machine |
| Every repository in the organisation | A lesson here, whose problem says it holds in every repository; it graduates into the baseline's skill (below) | The company's deploy pipeline needs a manual approval; an internal service's API contract |
| This task only | Nowhere | A one-off workaround; a guess you have not confirmed |

- Confirmed means the fix worked, the code shows it, or the user said so. A suspicion is not a lesson.
- A correction from the user: about the code or the project, a lesson; about how they want you to work with them, your memory.
- One place only. Never save the same thing as a lesson and in your own memory.
- When unsure whether a teammate's agent would need it, ask: would it have saved them time on this repository? Yes: a lesson.

## Record a lesson

```sh
npx opencastle lesson --title "Short descriptive title" --category terminal --severity high \
  --problem "What was observed" --wrong "Failing approach" --correct "Working solution" \
  --why "Root cause" --cite src/lib/payments.ts:42
```

- Required: `--title`, `--category`, `--severity`, `--problem`. Fill `--wrong` and `--correct` too: the contrast is what makes a lesson usable. The categories, and when each applies: [LESSON-CATEGORIES.md](LESSON-CATEGORIES.md).
- `--cite` the code the lesson is about. When that code changes, `doctor` says the lesson may no longer hold.
- Exact error messages and commands, in code blocks. Never a token, key or password: describe it instead ("the Stripe test key in `.env`").
- One lesson per command. It prints the new id, and refuses a lesson holding a credential or citing a file that does not exist.
- A lesson that shows a gap in a skill or an instruction file: fix that file too.

Search the lessons themselves first — the index has titles only — so you do not record one twice:

```bash
rg -i "CRON_SECRET" .opencastle/lessons/ || true
```

## When cited code has changed

`doctor` names it: `<id> cites <file>, which has changed since it was verified`. Read the lesson against the code:

| Still true? | Run |
|-------------|-----|
| Yes | `npx opencastle lesson verify <id>` |
| Yes, but the code moved | `npx opencastle lesson verify <id> --cite <new/path.ts>` |
| No longer | `npx opencastle lesson archive <id> --into <file that now covers it>` |

## Graduate lessons

Every agent reads every active lesson before every task, so a lesson that has proven itself belongs in the skill or instruction file it is about, where only the agents that need it read it. `doctor` warns when the index passes about 2,000 tokens. Candidates: older than 60 days and still true, a problem two lessons describe, `severity: high`, or one that holds in every repository.

1. Rewrite it as a rule or an example in that file, beside the rules it belongs with — a rule, not an incident report, and no new file. A lesson that holds in every repository belongs in the skill it is about in the organisation's baseline: change it there, and once the baseline version carrying it is installed here, archive it.
2. `npx opencastle lesson archive <id> --into <that file>`, or `--into skills/<name>` for a skill the baseline gives this repository. The lesson keeps its file and moves to the index's Archived section; never delete one.

Resolve two lessons that contradict each other before you merge either.
