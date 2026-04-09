# Docker Compose

## Deployment Modes

| Mode | How | Constraints |
|------|-----|-------------|
| Raw (paste YAML) | Paste compose content directly | No `build:`, no external file mounts; use `image:` and `content:` for inline files |
| Repository | git URL | Full Docker Compose features: `build:`, external mounts, multi-file |

## Magic Variables

Coolify auto-generates values for specially named env vars. Declare with port suffix, reference without.

| Type | Declaration Example | Generated Value |
|------|--------------------|-----------------| 
| `PASSWORD` | `SERVICE_PASSWORD_DB` | Random password |
| `PASSWORD_64` | `SERVICE_PASSWORD_64_KEY` | 64-char password |
| `USER` | `SERVICE_USER_ADMIN` | Random 16-char string |
| `URL` | `SERVICE_URL_APP_3000` | `https://app-uuid.example.com` + Traefik routing |
| `FQDN` | `SERVICE_FQDN_APP` | `app-uuid.example.com` (no scheme) |

**Declaration vs. Reference:**
```yaml
environment:
  - SERVICE_URL_APP_3000    # Declare with port → activates proxy routing
  - APP_URL=$SERVICE_URL_APP  # Reference without port → injects https://… URL
```

⚠️ Use hyphens before port numbers: `SERVICE_URL_MY-SERVICE_3000` ✅  NOT `SERVICE_URL_MY_SERVICE_3000` ❌

**Shared credentials** — same `SERVICE_PASSWORD_*` identifier across services = same generated value:
```yaml
services:
  db:   { environment: [SERVICE_PASSWORD_POSTGRES] }
  app:  { environment: [DB_PASS=$SERVICE_PASSWORD_POSTGRES] }  # same value
```

## Env Var Syntax

```yaml
environment:
  - NODE_ENV=production           # Hardcoded, hidden from UI
  - API_KEY=${API_KEY}            # Editable in UI (empty default)
  - LOG_LEVEL=${LOG_LEVEL:-info}  # Editable with default
  - SECRET=${SECRET:?}            # Required — blocks deploy if empty
```

## Health Check Patterns

```yaml
healthcheck:
  # HTTP
  test: ["CMD-SHELL", "wget --spider -q http://localhost:8080"]
  # PostgreSQL
  test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
  # MySQL
  test: ["CMD-SHELL", "healthcheck.sh --connect --innodb_initialized"]
  # Redis
  test: ["CMD-SHELL", "redis-cli ping"]
  interval: 5s
  timeout: 5s
  retries: 10
  start_period: 30s
```

## Coolify-Specific Extensions

```yaml
volumes:
  - /data/config:/app/config      # standard bind mount
  - source: /data/uploads
    target: /app/uploads
    is_directory: true            # Coolify creates the directory if missing

  - source: coolify-config
    target: /app/config/app.conf
    content: |                    # Inline file content (raw mode only)
      log_level = info
      bind = 0.0.0.0:8080
```

```yaml
# Exclude init/migration containers from health checks
services:
  migrate:
    image: myapp:latest
    command: ["migrate", "up"]
    labels:
      - "exclude_from_hc=true"
```

## Header Metadata (for community templates)

```yaml
# documentation: https://docs.example.com
# slogan: "One-click app name"
# category: self-hosted
# tags: Notes,Productivity
# logo: https://cdn.example.com/logo.png
# port: 3000
```

## Conversion Checklist

When converting a standard `docker-compose.yml` for Coolify:

1. **Mode check** — `build:` directives → Raw mode: replace with `image:`; Repo mode: keep
2. **Add header metadata** — `# documentation:`, `# slogan:`, `# category:`, `# tags:`, `# logo:`, `# port:`
3. **Replace credentials** — hardcoded passwords/users → `SERVICE_PASSWORD_*` / `SERVICE_USER_*`
4. **Replace URLs** — hardcoded URLs → `SERVICE_URL_*` variables
5. **Remove `ports:`** — for proxied services (Traefik handles routing via `SERVICE_URL_*`)
6. **Add health checks** — use patterns above; add `depends_on` with `condition: service_healthy`

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No Available Server" | Check `docker ps` for unhealthy containers |
| Variables not editable in UI | Use `${VAR}` syntax — not `VAR=value` |
| Magic variables not generating | Check spelling, `SERVICE_` prefix; requires Coolify ≥ v4.0.0-beta.411 |
| Port routing broken | Use `SERVICE_URL_NAME_PORT`, hyphen before port, remove `ports:` |
