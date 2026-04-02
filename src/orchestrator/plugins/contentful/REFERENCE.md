> Parent: [SKILL.md](./SKILL.md)

# Contentful Reference (REFERENCE.md)

Last Updated: 2026-03-31

## Migration & Rollback Patterns

- Best safe rollback: perform migrations in a sandbox environment and validate before promoting to `master`. If a migration is faulty, delete the sandbox and recreate it from `master` then re-run a corrected migration.
- Advanced rollback: write reverse migrations that undo schema changes (when feasible) and test them in sandbox.

## Validation Checklist

1. Query a representative sample of entries after migration and confirm required fields and unique constraints.
2. Run the site's build against sandbox content to catch runtime rendering issues.
3. Run integration tests that depend on the modified content types.