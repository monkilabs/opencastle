<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow Templates

Templates for recurring kinds of work that need more than the prompts give them: the steps, who does each, and what to check. The Team Lead follows one when a task matches it; in Claude Code each is also a `/oc:workflow-<name>` command.

| Template | For |
|----------|-----|
| [Database Migration](database-migration.md) | Schema, access-policy and data migrations |
| [CMS Schema Changes](schema-changes.md) | Content-model changes, and the queries and pages that use them |
| [Data Pipeline](data-pipeline.md) | Crawl → process → validate → import |
| [Performance Optimization](performance-optimization.md) | Measure → find the bottleneck → optimize → measure again |
| [Refactoring](refactoring.md) | Changing code without changing behaviour |
| [Security Audit](security-audit.md) | A security review, and fixing what it finds |

Feature work and bug fixes have prompts of their own: `implement-feature` and `bug-fix`.

Every template ends by pointing at [the shared delivery phase](shared-delivery-phase.md). The compiler replaces that pointer with the phase itself, so each installed template is complete and the phase is not installed on its own.
