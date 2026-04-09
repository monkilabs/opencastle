# Database & Service Management

## Supported Database Types

PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, ClickHouse, Dragonfly.

## Create Database

```
database action="create"
  type="postgresql"
  project_uuid="<uuid>"
  environment_name="production"
  server_uuid="<uuid>"
```

## Backup Management

```bash
# List backup schedules
database_backups action="list_schedules" database_uuid="<uuid>"

# Create schedule
database_backups action="create" database_uuid="<uuid>"
  frequency="0 2 * * *"  # Daily at 2 AM
  retention=7

# View executions
database_backups action="list_executions" database_uuid="<uuid>"
```

## Services

One-click service deployments (e.g., Plausible, Gitea, Uptime Kuma):

```bash
# List available services
list_services

# Create service
service action="create"
  project_uuid="<uuid>"
  environment_name="production"
  server_uuid="<uuid>"
  type="plausible"

# Manage env vars
env_vars resource="service" action="list" uuid="<uuid>"
```

## Database Lifecycle

```bash
control resource="database" action="start" uuid="<uuid>"
control resource="database" action="stop" uuid="<uuid>"
control resource="database" action="restart" uuid="<uuid>"
```
