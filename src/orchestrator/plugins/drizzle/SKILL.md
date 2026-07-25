---
name: drizzle-orm
description: "Drizzle ORM schema definition, type-safe queries, relational queries, CRUD operations, transactions, migrations with drizzle-kit, and database setup for PostgreSQL, MySQL, and SQLite. Use when defining database schemas, writing queries or joins, managing migrations, setting up a new Drizzle project, or working with drizzle-kit."
---

# Drizzle ORM

## Gotchas

- `drizzle(client, { schema })` — omit `{ schema }` and the `db.query.*` relational API silently does not exist.
- `relations()` is ORM-level metadata only and creates no constraint. Define `references(() => users.id, { onDelete: 'cascade' })` as well; you need both.
- Types come from `typeof table.$inferSelect` / `$inferInsert` — never hand-write them.
- SQL-like API (`db.select().from()`) for joins and aggregates; relational API (`db.query.x.findMany({ with: {...} })`) for nested reads. `insert`/`update`/`delete` give back nothing usable without `.returning()`.
- Inside `db.transaction(async (tx) => ...)` every call must use `tx`; a stray `db` call runs outside the transaction.
- Prepared statements need `sql.placeholder('id')` + `.prepare('name')`, then `.execute({ id })`.
- Partial selects (`db.select({ id: users.id })`) avoid loading unused columns; declare indexes in the table definition.

## drizzle-kit

- `generate` → review the SQL in the `out` dir → `migrate`. `push` is dev-only. Never edit generated SQL; fix the schema and regenerate. `check` validates migration history consistency.
- A column rename generates DROP + ADD, i.e. data loss. Hand-write the migration file instead — `ALTER TABLE users RENAME COLUMN old_name TO new_name;` — then `migrate` applies it.
- A new non-nullable column takes two migrations: add nullable → backfill → add `.notNull()` → migrate again.
- The programmatic migrator needs a single connection: `postgres(url, { max: 1 })`, then `migrate(drizzle(client), { migrationsFolder: './drizzle' })`, then close it.
- `drizzle.config.ts` must supply `dialect`, `schema`, `out`, and `dbCredentials.url` before any command runs.

Docs: https://orm.drizzle.team/
