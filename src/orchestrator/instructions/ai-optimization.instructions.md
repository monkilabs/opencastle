---
description: 'AI assistant optimization patterns for efficient context usage and tool calls'
applyTo: '**'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# AI Optimization

- **Batch what is independent** — reads, searches and checks that do not depend on each other go in one turn; what depends on an earlier result waits for it.
- **Read in large ranges** — search to locate, then read the range you need, not many small slices of one file.
- **Do not re-read** — a file or a sub-agent's result already in context is used as it is.
- **Verify once per phase** — run tests, lint and build after a batch of edits, not after each one.
- **Scale planning to the change** — one or two files: act; ten or more: decompose first.
- **Hand over what you know** — a delegation prompt names the files and facts the agent would otherwise rediscover.

<!-- End of AI Optimization Instructions -->
