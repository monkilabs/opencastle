---
name: vercel-deployment
description: "Vercel deployment workflows, environment management, domain configuration, and build troubleshooting. Use when deploying, checking deployment status, reviewing build logs, or managing environments."
---

# Vercel Deployment

Vercel-specific deployment patterns and MCP tool usage. For project-specific deployment architecture, environment variables, and key files, see [deployment-config.md](../../.opencastle/stack/deployment-config.md).

## Deployment Model

Branch → Environment mapping:

| Branch pattern | Environment |
|----------------|-------------|
| `main` | Production deployment (auto) |
| `feature/*`, `fix/*` | Preview deployment (auto) |

## MCP Tools

The Vercel MCP server provides these tools through `https://mcp.vercel.com`:

| Tool | Purpose |
|------|---------|
| `deploy_to_vercel` | Trigger a deployment |
| `get_deployment` | Check deployment status and metadata |
| `get_deployment_build_logs` | Read build output for debugging |
| `get_runtime_logs` | Read runtime logs for debugging |
| `list_deployments` | List recent deployments |
| `get_project` | Get project configuration |
| `list_projects` | List all projects in the team |
| `list_teams` | List available teams |
| `search_vercel_documentation` | Search Vercel docs |
| `check_domain_availability_and_price` | Domain availability check |

## Environment Variables

### Vercel Environment Scoping

Vercel supports three environment scopes — set variables for each appropriately:

| Scope | When Applied | Use For |
|-------|-------------|---------|
| **Production** | `main` branch deploys | Live secrets, production API keys |
| **Preview** | All non-production branches | Staging/test API keys |
| **Development** | `vercel dev` local server | Local development overrides |

### Best Practices

Verify required env vars exist in production and preview scopes.

## Build Troubleshooting

When builds fail, follow this workflow:

1. **Read build logs** — use `get_deployment_build_logs` to get the full output
2. **Check common causes:**
   - Missing environment variables
   - Node.js version mismatch (check `engines` in `package.json`)
   - Build command mismatch (verify in project settings)
   - Dependency resolution issues (lockfile out of sync)
  3. **Check runtime logs** — use `get_runtime_logs` for post-deploy errors
  4. **Verify deployment status** — use `get_deployment` to check state and error details

  ### Example troubleshooting commands (MCP payloads)

  1) Get build logs:

  ```json
  // tool: vercel/get_deployment_build_logs
  { "deployment_id": "dpl_abc123" }
  ```

  2) Get runtime logs:

  ```json
  // tool: vercel/get_runtime_logs
  { "deployment_id": "dpl_abc123", "limit": 200 }
  ```

  3) Re-deploy a specific commit after fixing an issue:

  ```json
  // tool: vercel/deploy_to_vercel
  { "project_id": "proj_xxx", "gitCommitSha": "abcd1234" }
  ```

  After re-deploying, re-check `get_deployment_build_logs` and `get_runtime_logs` to confirm the fix. Repeat until build succeeds.

## Cron Jobs (vercel.json)

Configure cron jobs in `vercel.json` under `crons[]` with path and schedule.
