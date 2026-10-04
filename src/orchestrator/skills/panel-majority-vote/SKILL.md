---
name: panel-majority-vote
description: "Three isolated reviewers vote PASS or BLOCK on a high-risk change; the majority decides, and every MUST-FIX any of them raises is fixed. Use for changes to auth, payments, data migrations or anything that deletes data, after a third fast-review FAIL, or when someone asks for an independent panel."
---

# Panel Majority Vote

For changes where a missed defect is expensive: auth and permissions, payments, data migrations, anything that deletes data. Everything else gets one reviewer (**fast-review**).

1. **Ask one question** — "Is this change safe to merge?" — with what answers it: the diff, the acceptance criteria, the test results, the files involved.
2. **Three reviewers, in parallel, in isolation.** Three sub-agents dispatched as the **Reviewer** with the identical prompt; none sees another's answer or the conversation. Each answers in exactly these sections:

   ```text
   VERDICT: PASS | BLOCK
   MUST-FIX: <defects that block, each with file:line>
   SHOULD-FIX: <improvements>
   QUESTIONS: <what the reviewer could not decide>
   ```

   Where it can, a reviewer exercises the change — runs the entrypoint, the migration, the request — rather than only reading the diff.
3. **Count.** PASS when two or three say PASS; otherwise BLOCK.
4. **Fix the union.** Every MUST-FIX any reviewer raised is fixed, or answered with evidence: one reviewer's catch counts, whatever the vote. Mark each with how many raised it (`2/3`).
5. **On BLOCK,** change the work and run the panel again with the same question — never reword it to get a PASS. Blocked a second time: stop, and tell the user what blocks it.

Report the verdict, the tally, and each MUST-FIX with what was done about it.
