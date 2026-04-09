# Drizzle Schema Patterns

## PostgreSQL

```typescript
import {
  pgTable, text, integer, boolean, timestamp, numeric,
  serial, uuid, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  age: integer('age'),
  active: boolean('active').default(true).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
}, (table) => [
  index('users_email_idx').on(table.email),
  uniqueIndex('users_active_email_idx').on(table.active, table.email),
]);
```

## MySQL

```typescript
import { mysqlTable, varchar, int, boolean, datetime } from 'drizzle-orm/mysql-core';

export const products = mysqlTable('products', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  price: int('price').notNull(), // store in cents
  inStock: boolean('in_stock').default(true),
  createdAt: datetime('created_at').default(sql`now()`),
});
```

## SQLite

```typescript
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const notes = sqliteTable('notes', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body'),
  score: real('score').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .default(sql`(unixepoch())`)
    .notNull(),
});
```

## Foreign Keys & Constraints

```typescript
export const posts = pgTable('posts', {
  id: uuid('id').defaultRandom().primaryKey(),
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  categoryId: uuid('category_id')
    .references(() => categories.id, { onDelete: 'set null' }), // nullable FK
});
```

## Relations

```typescript
import { relations } from 'drizzle-orm';

// One-to-many
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  comments: many(comments),
}));

// Many-to-many (via junction table)
export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}));
```

## Type Inference

```typescript
// Always use $inferSelect and $inferInsert — never write these types manually
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Partial insert type (e.g. when ID is generated externally)
export type CreateUserInput = Omit<NewUser, 'id' | 'createdAt' | 'updatedAt'>;
```
