---
name: coolify-deployment
description: "Deploys applications, databases, and services on self-hosted Coolify instances, manages environments and env vars, runs infrastructure diagnostics, and performs batch operations. Use when deploying apps to Coolify, managing Coolify servers, debugging deployment issues, setting up databases, or managing Coolify infrastructure."
---

# Coolify Deployment

Resource hierarchy: Server → Project → Environment → app/database/service. Start every session with `get_infrastructure_overview`.

## MCP tools

- `diagnose_app` / `diagnose_server` accept names, domains, or IPs — not just UUIDs. `find_issues` scans all infrastructure.
- Env var changes need a restart to take effect: `env_vars` → `control action="restart"`. `bulk_env_update` sets one key across many UUIDs.
- `deploy force_rebuild=true` only when cache corruption is suspected; plain deploys are faster.
- Responses carry HATEOAS `_actions` naming the next tool call and args — follow them instead of guessing.
- Deploy webhook (outside MCP): `curl -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/deployments/deploy?tag=v1.2.3"` (or `?uuid=<app-uuid>`).
- Databases supported: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, ClickHouse, Dragonfly. Backups: `database_backups action="create"` with cron `frequency` + `retention`.

## Docker Compose gotchas

- Raw mode (pasted YAML) forbids `build:` and external file mounts — use `image:` plus inline `content:` volumes. Repository mode (git URL) allows the full spec.
- Magic variables: declare with the port, reference without it. `SERVICE_URL_APP_3000` activates proxy routing; `$SERVICE_URL_APP` injects the URL. Hyphenate before the port — `SERVICE_URL_MY-SERVICE_3000`, never `SERVICE_URL_MY_SERVICE_3000`. Requires Coolify ≥ v4.0.0-beta.411.
- Reusing the same `SERVICE_PASSWORD_X` identifier in two services yields the same generated value.
- Delete `ports:` for proxied services; Traefik routes via `SERVICE_URL_NAME_PORT`.
- `VAR=value` is hidden from the UI, `${VAR}` is UI-editable, `${VAR:?}` blocks the deploy when empty.
- Label init/migration containers `exclude_from_hc=true` to keep them out of health checks.
- Volume `is_directory: true` makes Coolify create a missing directory.
- "No Available Server" usually means an unhealthy container — check `docker ps`.

Docs: https://coolify.io/docs
