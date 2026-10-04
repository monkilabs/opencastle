---
description: 'Fix a bug in this session: reproduce it, find the root cause, fix it with a regression test, verify it, and open a pull request.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Fix a Bug

Fix the bug the user described with this command, here, in this session.

## 1. Reproduce it

- Look for it in `.opencastle/KNOWN-ISSUES.md` and `.opencastle/LESSONS-LEARNED.md`, and read the tracker issue if the report names one.
- Reproduce it before changing anything: a failing test when you can write one, otherwise the exact steps — for a UI bug, in a browser (**browser-testing**). Note the expected and the actual behaviour.
- Cannot reproduce it? Say what you tried and ask for what is missing. Do not fix by guessing.

## 2. Find the root cause

- Trace the failing path from the input to the wrong output. `git log` on the files involved shows what changed recently.
- Name the cause in one sentence. A change that only hides the symptom — a silent `catch`, an `!important`, a retry around a race — is not a fix.

## 3. Fix it

- The smallest change that removes the cause. No refactoring around it.
- A regression test that fails without the fix and passes with it.
- Shared code: check every place that uses it.

## 4. Verify and deliver

- The reproduction passes now; run the project's tests, lint and build.
- Have the fix reviewed (**fast-review**). One that touches auth, permissions or data access: **panel-majority-vote**.
- Commit on a branch and open a pull request (**git-workflow**). Report the cause, the fix, the test, and how you verified it.
- It fixes an entry in `.opencastle/KNOWN-ISSUES.md`: update or remove the entry. A cause others will hit again: record a lesson (**self-improvement**).
