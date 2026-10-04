<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: CMS Schema Changes

For a change to the content model: new types or fields, renames, and the queries and pages that use them. The CMS's own syntax and tools are in its skill and in `.opencastle/stack/<cms>-config.md`.

1. **Analyse** (Content Engineer). Read the current schema and the queries the change affects, and check the content already in the CMS: what does a new required field mean for existing documents? Write down the field mapping, new against existing.
2. **Change the schema** (Content Engineer). Add the types and fields with their validation rules, register them, and run the CMS's own schema check. A rename or a removal ships with a migration — or keeps serving the old field under the new name until one does.
3. **Update the queries** (Content Engineer or Developer). Every query that reads the changed fields, and the types of their results; test them against real content.
4. **Integrate** (Developer). Update the pages and components, handling content that lacks the new field; run the tests, lint and build; check the pages in a browser.
5. **Verify** (Team Lead). The content model behaves in the CMS's editor, old content still renders, and the pages show the new fields.

## Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
