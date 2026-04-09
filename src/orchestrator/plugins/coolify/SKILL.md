---
name: coolify-deployment
description: "Deploys applications, databases, and services on self-hosted Coolify instances, manages environments and env vars, runs infrastructure diagnostics, and performs batch operations. Use when deploying apps to Coolify, managing Coolify servers, debugging deployment issues, setting up databases, or managing Coolify infrastructure."
---

# Coolify Deployment

## Topic Routing

Read the matching reference before working on any of these topics:

| Topic | Reference |
|-------|-----------|
| Application deployment | `references/applications.md` |
| Database & service management | `references/databases-services.md` |
| Infrastructure & diagnostics | `references/infrastructure.md` |
| Docker Compose templates | `references/docker-compose.md` |
| CI/CD & Docker image deploys | `references/ci-cd-webhooks.md` |

## Critical Rules

**Project Structure**
- Coolify organizes resources as: Server → Project → Environment → Resources (apps, databases, services)
- Always start with `get_infrastructure_overview` to understand the current state before making changes
- Use `projects` tool with action params (`list`, `get`, `create`) — one tool, multiple operations

**Application Deployment**
- Deploy from public repos, private GitHub repos (via GitHub App), SSH keys, or Docker images
- Configure health checks (path, interval, retries) during `application` create to avoid unhealthy deployments
- Use `deploy` with `force_rebuild: true` only when cache issues are suspected — normal deploys are faster
- Check deployment status with `deployment` action `list_for_app` after triggering a deploy

**Diagnostics**
- `diagnose_app` accepts name or domain (e.g., `"my-app"` or `"example.com"`) — not just UUIDs
- `diagnose_server` accepts name or IP address — use for connectivity and resource issues
- `find_issues` scans all infrastructure — use as a health check before and after changes

**Environment Variables**
- Use `env_vars` tool with `resource: "application"` or `resource: "service"` — supports `list`, `create`, `update`, `delete`
- `bulk_env_update` updates a variable across multiple apps at once — use for shared config like API URLs
- Env vars require app restart to take effect — use `control` with `action: "restart"` after updates

**Database Management**
- Supports 8 database types: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, ClickHouse, Dragonfly
- Configure backup schedules via `database_backups` with `action: "create"` — set frequency and retention
- Backups can target S3-compatible storage — configure via backup schedule creation

**Security**
- Store `COOLIFY_ACCESS_TOKEN` in `.env` — never commit to source control
- Private keys for SSH deployments: manage via `private_keys` tool, never hardcode
- Use `validate_server` to verify SSH connectivity before deploying

**Docker Compose**
- Coolify supports two compose modes: Raw (paste YAML, no `build:`) and Repository (git URL, full features)
- Use magic variables (`SERVICE_PASSWORD_*`, `SERVICE_URL_*`) for auto-generated credentials and proxy URLs — never hardcode
- Remove `ports:` for proxied services — Traefik handles routing via `SERVICE_URL_NAME_PORT`

**CI/CD Integration**
- Trigger deploys via webhook with tag or UUID — use for automated pipelines
- Docker image deployments (`create_dockerimage`) skip the build step — use for pre-built images from registries

## Workflow: Deploy Application

1. **Survey** — `get_infrastructure_overview` → identify target server and project
2. **Create project** (if needed) — `projects` action `create` with name and description
3. **Create environment** — `environments` action `create` in the target project
4. **Deploy** — `application` action `create_public` (or `create_github` / `create_dockerimage`) with health check config
5. **Verify** — `deployment` action `list_for_app` → wait for `finished` status; if `failed` → `application_logs` → fix → redeploy
6. **Set env vars** — `env_vars` resource `application` action `create` → `control` action `restart`
7. **Validate** — `diagnose_app` by name → confirm status `running` and health check passing

## Workflow: Diagnose & Fix

1. **Scan** — `find_issues` → list all unhealthy resources
2. **Investigate** — `diagnose_app` or `diagnose_server` with name/domain/IP
3. **Check logs** — `application_logs` for the affected app
4. **Fix** — update config, env vars, or redeploy as needed
5. **Restart** — `control` resource `application` action `restart`
6. **Verify** — `diagnose_app` again → confirm status `running`

## Deployment Failure Recovery

```
Deploy failed → check status
├── Health check failing → verify health check path returns 200 → fix app → redeploy
├── Build error → application_logs → fix Dockerfile/build config → deploy with force_rebuild
├── Port conflict → check server_resources → update port mapping → redeploy
├── SSH key invalid → validate_server → private_keys action update → retry
└── Out of resources → server diagnostics → scale server or stop unused apps
```

## Deploy Public Repo — Full Example

```
# 1. Create app from public repo
application(
  action="create_public",
  project_uuid="proj-abc",
  environment_name="production",
  server_uuid="srv-xyz",
  repository_url="https://github.com/org/my-app",
  branch="main",
  build_pack="dockerfile",
  health_check_path="/health",
  health_check_interval=30,
  health_check_retries=3
)
# → returns { uuid: "app-123", status: "deploying" }

# 2. Set env vars
env_vars(resource="application", action="create", uuid="app-123", key="DATABASE_URL", value="postgres://...", is_preview=false)

# 3. Restart to pick up env vars
control(resource="application", action="restart", uuid="app-123")

# 4. Verify
diagnose_app(identifier="my-app")
# → status: "running", health_check: "healthy"
```

## MCP Config (VS Code)

```json
{
  "servers": {
    "Coolify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@masonator/coolify-mcp"],
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```
