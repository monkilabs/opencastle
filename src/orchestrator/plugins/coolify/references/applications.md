# Application Deployment

## Deployment Sources

| Source | Action | Key Args |
|--------|--------|----------|
| Public Git repo | `create_public` | `repository_url`, `branch` |
| GitHub App | `create_github` | `github_app_uuid`, `repository_url`, `branch` |
| SSH key | `create_key` | `private_key_uuid`, `repository_url`, `branch` |
| Docker image | `create_dockerimage` | `docker_image`, `docker_registry` |

## Create Application

```
application action="create_public"
  project_uuid="<uuid>"
  environment_name="production"
  server_uuid="<uuid>"
  repository_url="https://github.com/org/repo"
  branch="main"
  build_pack="dockerfile"
  health_check_path="/health"
  health_check_interval=30
  health_check_retries=3
```

## Application Lifecycle

```bash
# List all apps (summaries)
list_applications

# Full details for one app
get_application uuid="<uuid>"

# View logs
application_logs uuid="<uuid>" lines=100

# Deploy (with optional force rebuild)
deploy uuid="<uuid>" force_rebuild=true

# Restart/stop/start
control resource="application" action="restart" uuid="<uuid>"
```

## Environment Variables

```bash
# List env vars
env_vars resource="application" action="list" uuid="<uuid>"

# Create env var
env_vars resource="application" action="create" uuid="<uuid>" key="DATABASE_URL" value="postgres://..." is_preview=false

# Bulk update across apps
bulk_env_update key="API_URL" value="https://api.example.com" uuids=["<uuid1>","<uuid2>"]
```

## Health Check Configuration

Always configure health checks to prevent deploying broken apps:

- `health_check_path` — endpoint that returns 200 (e.g., `/health`, `/api/health`)
- `health_check_interval` — seconds between checks (default: 30)
- `health_check_retries` — failures before marking unhealthy (default: 3)
