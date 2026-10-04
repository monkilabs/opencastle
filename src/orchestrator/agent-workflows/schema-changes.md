<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Schema / CMS Changes

Structured workflow for CMS schema modifications, query updates, and content model changes.

> **Project config:** For CMS-specific paths, schema locations, and query library details, see the relevant CMS customization file in `.opencastle/stack/`.

## Phases

```
Phase 1: Schema Analysis      (sub-agent, inline)
Phase 2: Schema Implementation (sub-agent or background)
Phase 3: Query Updates         (sub-agent, sequential)
Phase 4: Page Integration      (sub-agent, sequential)
Phase 5: Verification          (sub-agent, inline)
Phase 6: Delivery              (direct, Team Lead)
```

---

## Branch & Delivery Strategy

The Team Lead creates the branch before any delegation and delivers it as the Delivery phase below describes. Branch naming: `feat/<ticket-id>-<short-description>` or `chore/<ticket-id>-<short-description>`.

---

## Phase 1: Schema Analysis

**Agent:** Content Engineer (via sub-agent)
**Type:** Sub-agent (inline)

### Steps

1. Read current CMS schema to understand existing types
2. Check the data model documentation (Key Documentation in `.opencastle/project.instructions.md`) for field documentation
3. Check the query library (see CMS customization) for queries that will be affected
4. Verify schema changes don't conflict with existing content in the CMS
5. Document field mapping (new vs existing fields)
6. Create tracker issue with schema change details

### Exit Criteria

- [ ] Existing schema understood
- [ ] Impact on data queries assessed
- [ ] Impact on existing content assessed
- [ ] Tracker issue created
- [ ] Approach decided (new type vs modify existing)

---

## Phase 2: Schema Implementation

**Agent:** Content Engineer
**Type:** Sub-agent (simple changes) or Background (complex schema additions)

### File Partition

> See the CMS customization file for project-specific paths.

- CMS schema directory — schema type files
- CMS config file — schema registry

### Steps

1. Create or modify schema type files using `defineType` / `defineField`
2. Add validation rules where appropriate
3. Update the schema index to register new types
4. Deploy schema (see CMS customization for deploy command)
5. Verify in CMS studio that the schema renders correctly
6. Create any necessary content for new types

### Exit Criteria

- [ ] Schema files created/modified
- [ ] Schema deployed successfully
- [ ] Schema renders correctly in CMS Studio
- [ ] Existing content not broken by changes
- [ ] Output contract returned

---

## Phase 3: Query Updates

**Agent:** Content Engineer or Developer (via sub-agent)
**Type:** Sub-agent (sequential — depends on Phase 2)

### File Partition

> See the CMS customization file for project-specific query library paths.

- Query library — data query files

### Steps

1. Update data queries to include new/modified fields
2. Update TypeScript types for query results
3. Test queries in the CMS query tool
4. Run query library tests

### Exit Criteria

- [ ] Data queries updated
- [ ] TypeScript types match schema
- [ ] Queries tested in CMS query tool
- [ ] Query tests pass
- [ ] Output contract returned

---

## Phase 4: Page Integration

**Agent:** Developer (via sub-agent)
**Type:** Sub-agent (sequential — depends on Phase 3)

### File Partition

- Varies by feature — typically app page routes and shared UI components

### Steps

1. Update components to use new/modified fields
2. Handle missing data gracefully (backwards compatibility)
3. Run lint + test + build for affected projects
4. Start dev server and verify in browser

### Exit Criteria

- [ ] Components updated
- [ ] Missing data handled gracefully
- [ ] Lint + test + build pass
- [ ] Visual verification in browser
- [ ] Output contract returned

---

## Phase 5: Verification

**Agent:** Team Lead (self)
**Type:** Direct verification

### Steps

1. Review all output contracts
2. Verify in CMS that content can be created/edited
3. Start dev server and verify pages render correctly
4. Check both apps if shared schema/queries changed
5. Verify data model documentation is updated
6. Move tracker issue to Done

### Exit Criteria

- [ ] Schema works in CMS
- [ ] Pages render correctly in browser
- [ ] Both apps verified (if shared code changed)
- [ ] Data model documentation updated (if applicable)
- [ ] Tracker issue moved to Done
- [ ] Delivery phase completed — branch pushed, PR opened (not merged), tracker linked

---

### Phase 6: Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
>
> Commit → Push → PR → tracker linkage. Team Lead owns delivery.
