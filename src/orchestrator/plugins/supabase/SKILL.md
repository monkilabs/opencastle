---
name: supabase-database
description: "Generates Supabase database migrations, writes RLS policies with auth.uid(), configures auth integration, and generates TypeScript types. Use when creating tables, writing migrations, configuring RLS, or implementing Supabase auth."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Supabase Database

Generic Supabase development methodology. For project-specific schema, roles, migration history, auth flow, and key files, see [supabase-config.md](../../.opencastle/stack/supabase-config.md).

## Migration Rules (sequential workflow)

1. Plan: create a migration with a descriptive name (`YYYYMMDD_add_profiles.sql`) and list expected schema changes.  
2. Author: write the SQL migration and include inline comments describing intent and rollback considerations.  
3. Local validate: apply the migration to a local or ephemeral DB; run smoke tests and verify RLS policies for `anon`, `user`, and `admin`.  
4. Inspect: review generated SQL for destructive actions (table drops, column rewrites). If destructive, add backfill scripts and phased changes.  
5. CI verify: run the migration in CI against a test replica and run the full test suite.  
6. Deploy: promote migration to production using the project's safe-deploy pipeline.  
7. Post-check: verify row-level security, indexes, and perform a small data validation query.

Validation checkpoints: after steps 3 and 5 assert (a) migration completes, (b) RLS policies still pass for role-specific queries, (c) tests covering changed paths pass. On failure: revert, adjust migration, and re-run.

## Migration Example (consolidated)

```sql
-- 20260331_create_profiles.sql
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- RLS: Users can read all profiles, update only their own
CREATE POLICY "Profiles are viewable by everyone"
  ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Type generation (CI):
-- supabase gen types typescript --project-id <project-id> > src/types/supabase.ts
```

## Verification

```sql
-- Confirm RLS is enabled on all tables
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
```
