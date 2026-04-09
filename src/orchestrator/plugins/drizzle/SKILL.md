---
name: drizzle-orm
description: "Drizzle ORM schema definition, type-safe queries, relational queries, CRUD operations, transactions, migrations with drizzle-kit, and database setup for PostgreSQL, MySQL, and SQLite. Use when defining database schemas, writing queries or joins, managing migrations, setting up a new Drizzle project, or working with drizzle-kit."
---

# Drizzle ORM

## Topic Routing

Read the matching reference before writing code for any of these topics:

| Topic | Reference |
|-------|-----------|
| Schema definition & column types | `references/schema-patterns.md` |
| Queries, joins, & CRUD operations | `references/query-patterns.md` |
| Migrations & drizzle-kit | `references/migrations.md` |

## Critical Rules

**Schema**
- Define schemas in dedicated `schema.ts` files using `pgTable` / `mysqlTable` / `sqliteTable` from the correct dialect package
- Use `$inferSelect` and `$inferInsert` for TypeScript types — never duplicate type definitions manually
- Foreign keys require explicit `references(() => table.column)` — omitting this creates an unconstrained column
- Pass `{ schema }` to `drizzle()` when initializing the client to enable relational queries

**Relations**
- Define with `relations()` from `drizzle-orm` alongside the table definition
- Relations are required for `db.query` relational API — the SQL-like API does not use them
- Do not use relations as a substitute for foreign key constraints; define both

**Queries**
- Use SQL-like API (`db.select().from()`) for complex joins and aggregations
- Use relational API (`db.query.table.findMany({ with: { ... } })`) for nested data fetching
- Import `eq`, `and`, `or`, `gt`, `like`, `isNull` etc. from `drizzle-orm` for `where` clauses
- Always use `returning()` to get the inserted, updated, or deleted rows back

**Migrations**
- Use `drizzle-kit` for all migrations: `npx drizzle-kit generate` then `npx drizzle-kit migrate`
- Configure in `drizzle.config.ts` — connections string must be set before running commands
- Never manually edit generated migration SQL files — regenerate if changes are needed
- Use `npx drizzle-kit push` in development only; always use `migrate` for production

**Transactions**
- Wrap multi-step operations in `db.transaction(async (tx) => { ... })`
- Use `tx` (the transaction argument) instead of `db` for all queries inside the callback

**Performance**
- Use `db.select({ col: table.col })` for partial selects — avoids loading unused columns
- Add indexes in the schema definition for frequently queried columns
- Use `.prepare()` for repeated queries (prepared statements)

## Schema Definition

```typescript
import { pgTable, text, integer, timestamp, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  authorId: text('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  published: boolean('published').default(false).notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));

// Type inference — no manual duplication
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

## Query Patterns

```typescript
import { db } from './db';
import { eq } from 'drizzle-orm';
import { users, posts } from './schema';

// SQL-like: select with join
const results = await db
  .select({ user: users, postCount: count(posts.id) })
  .from(users)
  .leftJoin(posts, eq(posts.authorId, users.id))
  .groupBy(users.id);

// Relational: nested fetch
const usersWithPosts = await db.query.users.findMany({
  where: eq(users.id, userId),
  with: { posts: { where: eq(posts.published, true) } },
});

// Insert with returning
const [newUser] = await db.insert(users).values({ id, email, name }).returning();
```

## Reference Files

- `references/schema-patterns.md` — Table definitions, column types, constraints, indexes, relations, type inference
- `references/query-patterns.md` — Select, joins, where clauses, relational API, CRUD, transactions, prepared statements
- `references/migrations.md` — drizzle.config.ts, generate/migrate/push commands, migration workflow

## Quick Workflow: Set up Drizzle in a project
1. Install: `npm install drizzle-orm` + dialect driver (`postgres` / `@libsql/client` / `better-sqlite3`)
2. Install drizzle-kit: `npm install -D drizzle-kit`
3. Define schema in `src/db/schema.ts` using the correct dialect table builder
4. Create `drizzle.config.ts` with database URL and schema path — verify the config before running commands
5. Generate migration: `npx drizzle-kit generate` — inspect the SQL output before applying
6. Apply migration: `npx drizzle-kit migrate`
   - **If migration fails:** check DB connection string → verify schema matches existing tables → use `npx drizzle-kit push` for dev environments
7. Initialize client: `const db = drizzle(pool, { schema })` and run a test query to confirm connectivity
