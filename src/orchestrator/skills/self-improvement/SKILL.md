---
name: self-improvement
description: "Keeps the team's memory: where what you learned goes (your memory, shared with the team when it is about the project, or a lesson in .opencastle/lessons/), and how lessons are cited, re-verified and graduated. Use when you confirm something true for anyone working in the repository (a fix after a failure, a convention, a decision, a quirk, a correction about the code), when you touch a lesson copied from memory, when doctor reports a lesson's cited code changed, or when the lessons index grows long."
---

# Self-Improvement

Lessons are the team's memory. A lesson is a file in `.opencastle/lessons/`, committed with the change you made, so the team reviews it in that pull request. `.opencastle/LESSONS-LEARNED.md` is the index, and Claude Code, VS Code, Cursor and Windsurf load a copy of it before every task; both are rewritten from the lesson files — never edit them by hand.

## The team's or the user's

Decide when you learn it, by how you save it. Nobody sorts memories afterwards.

In Claude Code and VS Code, save it in your own memory as you normally do. When the session ends, OpenCastle copies what is about the project into a lesson, and leaves what is about the user. In any other assistant, record what is about the project as a lesson yourself (below).

| It is about | Save it as | For example |
|-------------|------------|-------------|
| The project: true for anyone working in this repository | About the project (a correction, a project note, a pointer to where something lives) | `pnpm build` fails without `CI=1` set; every migration ships with a down file; the staging API allows 10 requests a second; the user says "we never use default exports" |
| The user: true for them, wherever they work | About the user. It stays theirs and never becomes a lesson | They want short answers; they use fish; their role; their editor; paths on their machine |
| Every repository in the organisation | About the project, saying it holds in every repository; it graduates into the baseline's skill (below) | The company's deploy pipeline needs a manual approval; an internal service's API contract |
| This task only | Nothing | A one-off workaround; a guess you have not confirmed |

- Confirmed means the fix worked, the code shows it, or the user said so. A suspicion is not worth saving.
- A correction from the user: about the code or the project, it is about the project; about how they want you to work with them, it is about the user.
- A lesson copied from memory is category `general`, severity `medium`, and cites nothing. When your task touches one, set them in its file, and cite the code with `npx opencastle lesson verify <id> --cite <path>`.

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
