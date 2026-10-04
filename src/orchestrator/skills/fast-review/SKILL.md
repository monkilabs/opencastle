---
name: fast-review
description: "One independent reviewer checks a change against its acceptance criteria and answers PASS or FAIL before it is accepted. Use before accepting delegated work, before delivering a change, or when someone asks for a review."
---

# Fast Review

A change is reviewed by someone who did not write it: one reviewer — a sub-agent dispatched as the **Reviewer** — who sees only what it needs.

## When to skip it

No reviewer for research with no code change, a docs-only change, or ≤10 lines across ≤2 files with the project's tests, lint and build passing — **except** auth or middleware, migrations, access policies, security headers or CSP, environment variable schemas, and CI/CD config, which are reviewed even for one line. A review never replaces tests, lint and build: run those first.

## Review

Give the reviewer the acceptance criteria, the diff, the files the change was allowed to touch, and the results of the tests, lint and build — not the conversation or the delegation prompt: it judges the result, not the intent.

```text
You review a change. Be concise and specific.

Task: <title>. Acceptance criteria: <list>
Files it may change: <paths>
Diff: <diff>
Tests / lint / build: <passed or failed>
Previous FAIL, on a retry: <its feedback>

Check: the criteria are met · only the allowed files changed · nothing regressed ·
errors are surfaced, not swallowed · the types are sound · no secret or injection
vector · the edge cases are handled.

VERDICT: PASS | FAIL
ISSUES:
- [critical|major|minor] <description, file:line>
FEEDBACK: <what to change>
```

PASS: no critical or major issue; minor ones are noted, not blocking. FAIL: any critical or major issue, or an answer not in that shape.

## After a FAIL

| What happened | What to do |
|---|---|
| FAIL, the first or second time | Fix it, or send it back to its author with the feedback ("retry N of 2"), and review again |
| FAIL a third time | A panel of three (**panel-majority-vote**) |
| The panel blocks it, or the reviewers disagree on what is right | Stop, and tell the user what blocks it, with each side's evidence |
| The agent crashes, times out or returns nothing usable, twice | Stop and tell the user; do not try a third time |

A panel costs three reviews: it is not a fast review. Never accept a FAIL without fixing it or asking.
