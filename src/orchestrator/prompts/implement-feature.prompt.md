---
description: 'Implement a feature or change in this session — a roadmap item or a small follow-up: understand it, plan it to its size, build it with tests, verify it, have it reviewed, and open a pull request.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Implement a Feature

Implement the change the user gave with this command — a feature, a roadmap item, or a follow-up tweak — here, in this session. (Work to plan into parallel tasks and run unattended is `/oc:convoy`.)

## 1. Understand it

- Restate the goal and what "done" means in a sentence or two. If either is unclear and a guess would waste work, ask first; for a large or open-ended request, suggest `/oc:brainstorm`.
- Read what applies: the Project Context, `.opencastle/LESSONS-LEARNED.md`, `.opencastle/KNOWN-ISSUES.md`, and the code you will touch. Look for what already exists before writing anything new.
- A tracker issue named in the request: read it. Its acceptance criteria are the definition of done.

## 2. Plan it to its size

- **One area, a few files:** do it yourself, now.
- **Several areas (API, UI, data, tests):** split it into tasks that each own their files, order them by dependency (shared types and schema, then the API, then the UI), and hand each to the specialist agent that fits, as the Team Lead does. Tasks that run at the same time never share a file.

## 3. Build it

- Follow the project's conventions and the skill for each domain you touch.
- Write or update the tests with the change, not after it.
- Stay in scope: no refactoring the change does not need.

## 4. Verify it

- Run the project's tests, lint and build (Key Commands) and fix what fails.
- A UI change: check it in a browser — it works at mobile and desktop widths, with no console errors (**browser-testing**).
- Have it reviewed by someone who did not write it (**fast-review**). Auth, payments, data migrations, or anything that deletes data: **panel-majority-vote**.

## 5. Deliver

- Commit on a feature branch and open a pull request; never push to `main` (**git-workflow**). Link the tracker issue when there is one.
- Report what changed (files), how you verified it, what is still open, and anything you noticed outside the task, with its file and line.
- A retry that taught you something the next agent should know: record it (**self-improvement**).
