---
name: prisma-database
description: "Prisma ORM schema design, migrations, client generation, and query patterns. Use when designing database schemas, writing migrations, querying data, or managing Prisma Client."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Prisma Database

Project schema and connection details: [database-config.md](../../.opencastle/stack/database-config.md). Docs: https://www.prisma.io/docs

## Migration rules

- `npx prisma migrate dev` in development only — **never in production**; it can reset data. CI/production uses `npx prisma migrate deploy`.
- Inspect `prisma/migrations/<timestamp>/migration.sql` before applying. Destructive operations (drops, column rewrites) need an explicit backfill step added to the migration.
- **Never edit an already-applied migration file** — the checksum is recorded and will fail. Write a corrective migration instead.
- `npx prisma generate` after every schema change; a stale client silently mismatches the DB. `npx prisma db push` skips migration history entirely — prototyping only.

## Schema gotchas

- Use `cuid()` / `uuid()` for IDs, not serial increments, in anything distributed.
- Renaming a field without matching `@map`/`@@map` produces a *column drop plus add*, not a rename. Check both when renaming.
- Add `@@index` explicitly on frequently queried columns — the schema does not imply them.
- Write `@relation` explicitly, including `onDelete` (e.g. `onDelete: Cascade`); leaving it implicit means the delete behavior is whatever the connector defaults to.
- Include `createdAt @default(now())` and `updatedAt @updatedAt` for auditability.

## Client and queries

Hot reload in dev creates a new `PrismaClient` per reload and exhausts the connection pool. Use the global singleton:

```typescript
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

Use `select` for narrow reads, `include` for relations, `prisma.$transaction` for multi-step writes. Catch error code **`P2002`** for unique-constraint violations and handle it rather than letting it surface as a 500.

Other commands: `prisma studio` (visual editor), `prisma db pull` (introspect), `prisma db seed`, `prisma validate`, `prisma format`.
