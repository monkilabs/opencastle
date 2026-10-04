<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Database Migration

For a schema change, an access-policy change or a data migration. The database's own syntax and tools are in its skill and in `.opencastle/stack/<database>-config.md`.

1. **Plan** (Data Engineer). Read the current schema, its access policies and the known issues. Write down the tables and columns affected, the policy changes, what happens to existing rows, and how to roll it back.
2. **Migrate** (Data Engineer). A new migration in the project's naming convention — never a hand edit of the schema. Re-runnable; every new table guarded by its access control, deny by default and allow explicitly; an index for each column you query by; the rollback written with it. Apply it locally, then apply it again: the second run changes nothing.
3. **Regenerate the types** (Data Engineer), when the project generates them from the schema, and check they compile.
4. **Integrate** (Developer). Update the handlers and components that read or write the changed tables; run the tests, lint and build; check the affected pages in a browser.
5. **Verify** (Team Lead). Exercise each access policy from every role that should and should not see the rows; spot-check the data; walk the feature end to end. A change to auth or to access policies gets **panel-majority-vote**.

## Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
