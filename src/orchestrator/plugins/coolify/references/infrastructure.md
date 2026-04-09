# Infrastructure & Diagnostics

## Infrastructure Overview

Always start here — returns all servers, projects, apps, databases, services in one call:

```
get_infrastructure_overview
```

## Server Management

```bash
# List servers (summaries)
list_servers

# Full details
get_server uuid="<uuid>"

# Check resources on a server
server_resources uuid="<uuid>"

# List domains
server_domains uuid="<uuid>"

# Validate SSH connection
validate_server uuid="<uuid>"
```

## Diagnostics

Smart lookup — accepts names, domains, or IPs (not just UUIDs):

```bash
# App diagnostics (by name or domain)
diagnose_app identifier="my-app"
diagnose_app identifier="example.com"

# Server diagnostics (by name or IP)
diagnose_server identifier="192.168.1.100"
diagnose_server identifier="coolify-apps"

# Scan all infrastructure
find_issues
```

## Batch Operations

```bash
# Restart all apps in a project
restart_project_apps project_uuid="<uuid>"

# Redeploy all apps in a project
redeploy_project project_uuid="<uuid>"

# Emergency stop all apps (requires confirmation)
stop_all_apps confirm=true

# Bulk update env var across apps
bulk_env_update key="API_URL" value="https://new-api.example.com" uuids=["<uuid1>","<uuid2>"]
```

## Response Pattern

Coolify MCP returns HATEOAS-style `_actions` suggesting next steps:

```json
{
  "data": { "uuid": "abc123", "status": "running" },
  "_actions": [
    { "tool": "application_logs", "args": { "uuid": "abc123" }, "hint": "View logs" },
    { "tool": "control", "args": { "resource": "application", "action": "restart", "uuid": "abc123" }, "hint": "Restart" }
  ]
}
```

Follow `_actions` suggestions for efficient multi-step workflows.
