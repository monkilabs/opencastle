<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Shared Delivery Phase

The last phase of every workflow template, once the work is implemented and verified.

## Steps

1. **Commit** to the feature branch, with the tracker issue ID in the messages when there is one.
2. **Push** it: `git push -u origin <branch>`.
3. **Open a pull request**, with the body written to a file first so the shell cannot mangle it:
   ```bash
   GH_PAGER=cat gh pr create --base main --title "<title>" --body-file /tmp/pr-body.md
   ```
4. **Do NOT merge** — a person reviews and merges it.
5. **Link it** from the tracker issue, when there is one.

Whoever coordinates the work owns delivery: the Team Lead creates the branch before delegating, sub-agents work on that branch, and only the Team Lead pushes and opens the pull request.
