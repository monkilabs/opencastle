---
name: prisma-database
description: "Prisma ORM schema design, migrations, client generation, and query patterns. Use when designing database schemas, writing migrations, querying data, or managing Prisma Client."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Prisma Database

For project-specific database schema and connection details, see [database-config.md](../../.opencastle/stack/database-config.md).

## Commands

```bash
npx prisma init                    # Initialize Prisma in the project
npx prisma generate                # Generate Prisma Client from schema
npx prisma migrate dev             # Create and apply migration (dev)
npx prisma migrate deploy          # Apply pending migrations (production)
npx prisma migrate reset           # Reset database and apply all migrations
npx prisma db push                 # Push schema changes without migration
npx prisma db pull                 # Introspect database into schema
npx prisma db seed                 # Run seed script
npx prisma studio                  # Open visual database editor
npx prisma format                  # Format schema file
npx prisma validate                # Validate schema syntax
```

## Schema Design

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  posts     Post[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([email])
  @@map("users")
}

model Post {
  id        String   @id @default(cuid())
  title     String
  content   String?
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId  String

  @@index([authorId])
  @@map("posts")
}
```

### Schema Best Practices (Prisma gotchas)

- Use `cuid()` or `uuid()` for IDs in distributed systems (avoid serial increments).
- Always include `createdAt` and `updatedAt` timestamps for auditability and migrations.
- Prefer explicit `@relation` definitions and add `@@index` on frequently queried columns.
- Review `@map`/`@@map` uses when renaming to prevent accidental column/table mismatches.
- Avoid editing applied migration files; create corrective migrations instead.

## Migration Rules (Prisma-specific)

1. Use `npx prisma migrate dev` during development to generate migrations; inspect the generated SQL before applying.
2. Use `npx prisma migrate deploy` in CI/CD; never run `migrate dev` in production.
3. Name migrations descriptively and include backfill steps for destructive changes.
4. Regenerate the client after schema changes: `npx prisma generate`.

## Migration Workflow: validate → fix → retry (Prisma-focused)
1. Run `npx prisma migrate dev --name <desc>` locally to generate SQL.
2. Inspect `prisma/migrations/<timestamp>/migration.sql` for destructive operations and add backfills as needed.
3. Apply to a local/ephemeral DB and run tests; revert and adjust if failures occur.
4. Push migration to CI with `npx prisma migrate deploy` and assert clean application.

For query patterns, singleton client pattern, and runnable CRUD examples see REFERENCE.md in this directory.
