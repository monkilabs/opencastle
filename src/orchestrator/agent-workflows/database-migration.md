<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Database Migration

Structured workflow for database schema changes, RLS policies, and data migrations.

> **Project config:** For database-specific paths, schema details, and migration conventions, see the relevant database customization file in `.opencastle/stack/`.

## Phases

```
Phase 1: Migration Planning     (sub-agent, inline)
Phase 2: Migration Implementation (sub-agent or background)
Phase 3: Type Generation        (sub-agent, sequential)
Phase 4: Code Integration       (sub-agent, sequential)
Phase 5: Verification & Rollback Test (sub-agent, inline)
Phase 6: Delivery                     (direct, Team Lead)
```

---

## Branch & Delivery Strategy

Follow the **Delivery Outcome** in `general.instructions.md` and the **Branch Ownership** rules in `team-lead.agent.md`. Branch naming: `feat/<ticket-id>-<short-description>` or `fix/<ticket-id>-<short-description>`.

---

## Phase 1: Migration Planning

**Agent:** Data Engineer (via sub-agent)
**Type:** Sub-agent (inline)

### Steps

1. Read current schema in the migrations directory (see database customization) to understand existing tables
2. Check existing RLS policies using the database query tool
3. Read `.opencastle/project.instructions.md` for database architecture
4. Check `.opencastle/KNOWN-ISSUES.md` for database-related limitations
5. Document the migration plan: tables affected, columns added/removed, RLS changes
6. Write rollback strategy (how to reverse the migration)
7. Create tracker issue with migration details and rollback plan

### Exit Criteria

- [ ] Current schema understood
- [ ] Migration plan documented
- [ ] Rollback strategy defined
- [ ] Impact on existing data assessed
- [ ] Tracker issue created with rollback plan

---

## Phase 2: Migration Implementation

**Agent:** Data Engineer
**Type:** Sub-agent (simple changes) or Background (complex migrations)

### File Partition

> See the database customization file for project-specific migration paths.

- Migrations directory — migration SQL files

### Steps

1. Create migration file following naming convention: `YYYYMMDDHHMMSS_description.sql`
2. Write idempotent SQL (can safely re-run)
3. Include RLS policies for any new tables — default deny, explicit allow
4. Add indexes for frequently queried columns
5. Include SQL comments documenting the purpose
6. Apply migration using the database MCP tool
7. Verify migration applied successfully

### Exit Criteria

- [ ] Migration file created with idempotent SQL
- [ ] RLS policies included for new tables
- [ ] Indexes added for query columns
- [ ] Migration applied successfully
- [ ] Rollback SQL tested (or documented)
- [ ] Output contract returned

---

## Phase 3: Type Generation

**Agent:** Data Engineer (via sub-agent)
**Type:** Sub-agent (sequential — depends on Phase 2)

### Steps

1. Generate updated TypeScript types using the database MCP tool
2. Update any local type files that reference the changed tables
3. Verify types compile correctly

### Exit Criteria

- [ ] TypeScript types regenerated
- [ ] Types compile without errors
- [ ] Output contract returned

---

## Phase 4: Code Integration

**Agent:** Developer (via sub-agent)
**Type:** Sub-agent (sequential — depends on Phase 3)

### File Partition

- Varies by feature — typically Server Actions, API routes, React components

### Steps

1. Update Server Actions / API routes to use new schema
2. Update components to handle new data fields
3. Run lint + test + build for affected projects
4. Start dev server and test in browser

### Exit Criteria

- [ ] Server Actions updated
- [ ] Components updated
- [ ] Lint + test + build pass
- [ ] Browser verification complete
- [ ] Output contract returned

---

## Phase 5: Verification & Rollback Test

**Agent:** Team Lead (self)
**Type:** Direct verification

### Steps

1. Review all output contracts from Phases 2–4
2. Verify RLS policies from different user roles (anon, authenticated, admin)
3. Spot-check data using the database query tool
4. Start dev server and verify end-to-end functionality
5. **Security check:** If the migration touches auth or RLS, schedule panel review
6. Document rollback procedure in tracker issue
7. Move tracker issue to Done

### Exit Criteria

- [ ] RLS policies tested from multiple roles
- [ ] Data integrity verified
- [ ] End-to-end flow works in browser
- [ ] Panel review passed (if auth/RLS changes)
- [ ] Rollback procedure documented
- [ ] Tracker issue moved to Done
- [ ] Delivery Outcome completed (see `general.instructions.md`) — branch pushed, PR opened (not merged), tracker linked

---

### Phase 6: Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
>
> Commit → Push → PR → tracker linkage. Team Lead owns delivery.
