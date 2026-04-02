> Parent: [SKILL.md](./SKILL.md)

## Prisma Reference: Queries & Patterns

### Basic CRUD

```typescript
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Create
await prisma.user.create({ data: { email: 'user@example.com', name: 'Alice' } });

// Read (with relations)
await prisma.user.findUnique({ where: { id: userId }, include: { posts: true } });

// Update
await prisma.user.update({ where: { id: userId }, data: { name: 'Updated Name' } });

// Delete
await prisma.user.delete({ where: { id: userId } });
```

### Singleton client pattern

```typescript
import { PrismaClient } from '@prisma/client';
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

### Best-practice reminders
- Use `select` for narrow reads; prefer transactions (`prisma.$transaction`) for multi-step updates.
- Catch `P2002` for unique constraint violations and handle gracefully.
Last Updated: 2026-03-31

Reference: Prisma migration & production checklist

- Inspection checklist for generated SQL and destructive changes
- CI pipeline snippet for `prisma migrate deploy` and `prisma generate`
- Handling `P2002` unique constraint errors and remediation patterns
