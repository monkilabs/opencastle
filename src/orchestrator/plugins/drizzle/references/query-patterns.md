# Drizzle Query Patterns

## SQL-like API (complex joins & aggregations)

```typescript
import { db } from './db';
import { eq, and, or, gt, like, isNull, desc, count, sql } from 'drizzle-orm';
import { users, posts } from './schema';

// Basic select with where
const activeUsers = await db
  .select()
  .from(users)
  .where(and(eq(users.active, true), gt(users.age, 18)));

// Partial select (avoids loading unused columns)
const emails = await db
  .select({ id: users.id, email: users.email })
  .from(users);

// Join
const postsWithAuthors = await db
  .select({ post: posts, author: users })
  .from(posts)
  .innerJoin(users, eq(posts.authorId, users.id))
  .where(eq(posts.published, true))
  .orderBy(desc(posts.createdAt))
  .limit(20);

// Aggregate
const stats = await db
  .select({ total: count(), avgAge: sql<number>`avg(${users.age})` })
  .from(users);
```

## Relational API (nested data fetching)

```typescript
// Requires { schema } passed to drizzle() and relations defined in schema

// findMany with nested includes
const usersWithPosts = await db.query.users.findMany({
  where: eq(users.active, true),
  orderBy: desc(users.createdAt),
  limit: 10,
  with: {
    posts: {
      where: eq(posts.published, true),
      columns: { id: true, title: true, createdAt: true }, // partial columns
      orderBy: desc(posts.createdAt),
    },
  },
});

// findFirst
const user = await db.query.users.findFirst({
  where: eq(users.email, email),
  with: { posts: true },
});
```

## CRUD Operations

```typescript
// Insert — always use returning() to get back the created row
const [newUser] = await db
  .insert(users)
  .values({ id: crypto.randomUUID(), email, name })
  .returning();

// Upsert (on conflict)
const [upserted] = await db
  .insert(users)
  .values({ id, email, name })
  .onConflictDoUpdate({
    target: users.email,
    set: { name, updatedAt: new Date() },
  })
  .returning();

// Update
const [updated] = await db
  .update(users)
  .set({ name: 'New Name', updatedAt: new Date() })
  .where(eq(users.id, userId))
  .returning();

// Delete
const [deleted] = await db
  .delete(posts)
  .where(and(eq(posts.authorId, userId), eq(posts.published, false)))
  .returning();
```

## Transactions

```typescript
const result = await db.transaction(async (tx) => {
  // Use tx instead of db inside the transaction
  const [order] = await tx.insert(orders).values(orderData).returning();

  await tx.insert(orderItems).values(
    items.map((item) => ({ orderId: order.id, ...item }))
  );

  await tx
    .update(inventory)
    .set({ quantity: sql`${inventory.quantity} - 1` })
    .where(eq(inventory.productId, productId));

  return order;
});
```

## Prepared Statements

```typescript
// Define once, reuse many times
const getUserById = db
  .select()
  .from(users)
  .where(eq(users.id, sql.placeholder('id')))
  .prepare('get_user_by_id');

// Execute with parameters
const user = await getUserById.execute({ id: userId });
```
