---
description: 'Plan work as a convoy — tasks that agents run in parallel, each in its own git worktree, merged onto one branch — with the experimental convoy engine, and hand the plan over to run.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Plan a Convoy

Plan the work the user gave with this command as a convoy, for OpenCastle's convoy engine (experimental). OpenCastle's planner writes the plan; your part is to start it, check what it wrote, and hand it over. Do not write the spec yourself, and do not start the run.

1. **Check it is convoy work.** A convoy pays off for work that splits into several tasks with separate files — a feature across API, UI and tests, a change repeated across modules. A change in a few files is faster in this session: say so, suggest `/oc:implement-feature` or `/oc:bug-fix`, and stop.
2. **Check the work is committed.** Every task starts from the last commit, so changes it builds on must be committed first. Uncommitted changes: tell the user and stop.
3. **Plan it.** From the project root, run:

   `npx opencastle convoy "<the work in one paragraph, and what done means>" --dry-run`

   The planner reads the repository and changes nothing. It takes from under a minute to a few, writes the spec to `.opencastle/convoys/` — and, for larger work, a PRD to `.opencastle/prds/` — and prints the plan. It runs on the agent CLI `opencastle init` set up (claude, codex, cursor-agent, opencode or copilot); if that is not installed or signed in, it says so.
4. **Show the plan.** Each task, its agent, what it waits for and the files it may change; the checks that run at the end; where the spec is. Point out anything that looks wrong — a missing task, two tasks that should be one — and offer to plan again with a clearer description.
5. **Hand it over.** The user starts the run, in a terminal: `npx opencastle convoy run <spec>`. Tell them the engine is experimental, that the work lands on a branch of its own for them to review and merge, and that `npx opencastle convoy dashboard` shows it as it runs. A PRD they want to change: edit it, then `npx opencastle convoy plan --prd <file>`.
