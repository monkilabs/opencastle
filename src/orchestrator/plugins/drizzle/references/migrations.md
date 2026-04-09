# Drizzle Migrations

## drizzle.config.ts

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',           // 'postgresql' | 'mysql' | 'sqlite'
  schema: './src/db/schema.ts',    // path to your schema file(s)
  out: './drizzle',                // output directory for migrations
  dbCredentials: {
    url: process.env.DATABASE_URL!, // never hardcode credentials
  },
  verbose: true,
  strict: true,
});
```

## Commands

| Command | When to use |
|---------|------------|
| `npx drizzle-kit generate` | After schema changes — generates SQL migration files |
| `npx drizzle-kit migrate` | Apply pending migrations to the database (production-safe) |
| `npx drizzle-kit push` | Sync schema directly to DB without migrations (dev only) |
| `npx drizzle-kit studio` | Open local DB browser UI |
| `npx drizzle-kit check` | Validate migration history consistency |

## Migration Workflow

```bash
# 1. Change schema in src/db/schema.ts
# 2. Generate migration — inspect the SQL before applying
npx drizzle-kit generate

# 3. Review the generated .sql file in ./drizzle/
# 4. Apply to database
npx drizzle-kit migrate
```

**Never edit generated migration files.** If the generated SQL is wrong, adjust the schema and regenerate.

## Handling Breaking Changes

### Adding a required (non-nullable) column

```typescript
// Step 1: Add as nullable first
newColumn: text('new_column'),

// Step 2: Run migration to add the column → backfill data in a separate script/mutation
// Step 3: Add .notNull() after backfill is complete
newColumn: text('new_column').notNull(),

// Step 4: Run migration again to add the NOT NULL constraint
```

### Renaming a column

Drizzle Kit generates a DROP + ADD by default. To rename without data loss, use a custom migration:

```sql
-- drizzle/0002_rename_column.sql (manually created)
ALTER TABLE users RENAME COLUMN old_name TO new_name;
```

Then run `npx drizzle-kit migrate` — it will apply the custom file.

## Programmatic Migrations (CI / startup)

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const migrationClient = postgres(process.env.DATABASE_URL!, { max: 1 });
await migrate(drizzle(migrationClient), { migrationsFolder: './drizzle' });
await migrationClient.end();
```

## Database Client Setup

```typescript
// src/db/index.ts (PostgreSQL with postgres.js)
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const pool = postgres(process.env.DATABASE_URL!);
export const db = drizzle(pool, { schema });
```

```typescript
// src/db/index.ts (SQLite with better-sqlite3)
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';

const sqlite = new Database('sqlite.db');
export const db = drizzle(sqlite, { schema });
```

```typescript
// src/db/index.ts (Turso / libSQL)
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';

const client = createClient({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_TOKEN! });
export const db = drizzle(client, { schema });
```
