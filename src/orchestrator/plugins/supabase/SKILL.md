---
name: supabase-database
description: "Generates Supabase database migrations, writes RLS policies with auth.uid(), configures auth integration, and generates TypeScript types. Use when creating tables, writing migrations, configuring RLS, or implementing Supabase auth."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Supabase Database

Project schema, roles, migration history, auth flow, and key files: [supabase-config.md](../../.opencastle/stack/supabase-config.md). Docs: https://supabase.com/docs

## RLS gotchas

- **`ENABLE ROW LEVEL SECURITY` with no policy denies everything.** Enabling and adding policies must land in the same migration.
- Policies are per-operation. `FOR SELECT USING (...)` does not cover writes; `INSERT` needs `WITH CHECK`, not `USING`.
- `auth.uid()` is the owner check (`auth.uid() = id`). It is `NULL` for the `anon` role, so any policy relying on it silently blocks anonymous access.
- Test every policy against **all three** roles — `anon`, `user`, `admin`. A policy that works as your own user tells you nothing about `anon`.
- Reference `auth.users(id)` with `ON DELETE CASCADE` on profile-style tables, or deleted users leave orphans.

Confirm RLS coverage before shipping:

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
```

## Migration workflow

1. Name migrations `YYYYMMDD_add_profiles.sql`; comment intent and rollback considerations inline.
2. Apply to a local/ephemeral DB; run smoke tests plus per-role RLS checks.
3. Review the SQL for destructive actions (table drops, column rewrites) — those need a backfill script and phased rollout, never a single migration.
4. Re-run in CI against a test replica with the full suite.
5. Deploy via the safe-deploy pipeline, then re-verify RLS, indexes, and a data sanity query.

Regenerate types after every schema change (CI step):

```bash
supabase gen types typescript --project-id <project-id> > src/types/supabase.ts
```

Assert at steps 2 and 4 that the migration completes, per-role RLS queries still pass, and tests on changed paths pass. On failure: revert, adjust, re-run.
