# Discovered Issues Policy

> **⛔ No issue gets ignored.** Untracked bugs discovered during work are a quality gate failure.

When you encounter a bug, error, or unexpected behavior unrelated to the current task:

1. **Check if already tracked:**
   - Search `.opencastle/KNOWN-ISSUES.md` for a matching entry
   - If task tracker tools are available, search for open bugs
2. **If found tracked** — skip it, continue with your current work
3. **If NOT tracked** — you must act:
   - **Unfixable limitation** (third-party, platform, upstream) → add to `.opencastle/KNOWN-ISSUES.md` with: Issue ID, Status, Severity, Evidence, Root Cause, Solution Options
   - **Fixable bug** → create a tracker ticket with label `bug`, priority, symptoms, reproduction steps, and affected files. If no tracker tools available, add a `**Discovered Issues**` section to your output.

Never assume a pre-existing issue is somebody else problem. If it is not tracked, track it.
