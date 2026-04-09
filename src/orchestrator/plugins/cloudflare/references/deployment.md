# Cloudflare Deployment

## wrangler.toml Reference

```toml
name = "my-app"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]  # enable Node.js compat layer

# Environment variables (non-secret)
[vars]
ENVIRONMENT = "production"
API_BASE_URL = "https://api.example.com"

# Secrets — set via CLI, NOT stored here:
# wrangler secret put DB_PASSWORD

# KV binding
[[kv_namespaces]]
binding = "CACHE"
id = "abc123def456"
preview_id = "preview_abc123"  # for `wrangler dev --remote`

# D1 binding
[[d1_databases]]
binding = "DB"
database_name = "my-database"
database_id = "xyz789"

# R2 binding
[[r2_buckets]]
binding = "ASSETS"
bucket_name = "my-assets"

# Service binding (call another Worker)
[[services]]
binding = "AUTH_WORKER"
service = "auth-service"

# Cron Triggers
[triggers]
crons = ["0 0 * * *"]  # midnight UTC daily

# Per-environment overrides
[env.staging]
name = "my-app-staging"
vars = { ENVIRONMENT = "staging" }
```

## Pages Setup

```bash
# Create a new Pages project
npm create cloudflare@latest my-app -- --framework=nextjs

# Deploy from CLI
npx wrangler pages deploy ./dist --project-name=my-app

# Deploy a specific branch (creates preview)
npx wrangler pages deploy ./dist --project-name=my-app --branch=feature-xyz
```

### Pages Functions

```typescript
// functions/api/hello.ts — file-based routing in /functions
interface Env {
  MY_KV: KVNamespace;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const data = await context.env.MY_KV.get('greeting');
  return Response.json({ message: data ?? 'Hello!' });
};
```

## Environment Variables & Secrets

```bash
# List current secrets
wrangler secret list

# Add a secret (prompts for value)
wrangler secret put DATABASE_URL

# Add a secret for a specific environment
wrangler secret put DATABASE_URL --env staging

# Bulk secrets from .dev.vars (local dev only — never commit this file)
# .dev.vars format: KEY=value (one per line)
```

## Custom Domains

```bash
# Add a custom domain via dashboard or CLI
wrangler domains add my-worker.example.com

# For Pages: configure in the Cloudflare Dashboard under
# Pages → Project → Custom Domains
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Generate an API token at Cloudflare Dashboard → My Profile → API Tokens → Create Token (use the "Edit Cloudflare Workers" template).

## Preview Deployments

```bash
# Create a preview deployment (does not affect production)
npx wrangler deploy --env staging

# View deployment history
npx wrangler deployments list
```

## Rollback

```bash
# List recent deployments with version IDs
npx wrangler deployments list

# Roll back to a previous deployment
npx wrangler rollback <version-id>
```
