<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow Templates

Declarative workflow templates for common orchestration patterns. Inspired by Sandcastle's YAML workflow engine, these templates provide reproducible execution plans that the Team Lead and prompts can reference.

## How to Use

1. **Reference in prompts** — When delegating, cite the relevant template and phase
2. **Customize per task** — Templates define the structure; fill in specific files, agents, and criteria
3. **Track progress** — Use the phase structure to update session checkpoints

## Available Templates

| Template | Use Case |
|----------|----------|
| [Feature Implementation](feature-implementation.md) | Multi-layer features spanning DB → Query → UI → Tests |
| [Bug Fix](bug-fix.md) | Triage → RCA → Fix → Verify workflow |
| [Data Pipeline](data-pipeline.md) | Scrape → Convert → Enrich → Validate → Import |
| [Security Audit](security-audit.md) | Comprehensive security review workflow |
| [Performance Optimization](performance-optimization.md) | Measure → Analyze → Optimize → Verify |
| [Schema Changes](schema-changes.md) | CMS schema modifications, query updates, content model changes |
| [Database Migration](database-migration.md) | Database migrations, RLS policies, type generation, rollback |
| [Refactoring](refactoring.md) | Safe code refactoring with baseline metrics and behavior preservation |

Every template ends by pointing at [the shared delivery phase](shared-delivery-phase.md). The compiler replaces that pointer with the phase itself, so each installed template is complete and the phase is not installed on its own.
