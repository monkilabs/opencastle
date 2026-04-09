# CI/CD & Docker Image Deployments

## Webhook-Triggered Deployments

```bash
# Trigger deploy by image tag
deploy_webhook tag="v1.2.3"

# Trigger deploy by application UUID
deploy_webhook uuid="<app-uuid>"
```

REST API equivalent (outside MCP):
```bash
# By tag
curl -H "Authorization: Bearer $COOLIFY_TOKEN" \
     "$COOLIFY_URL/api/v1/deployments/deploy?tag=v1.2.3"

# By UUID
curl -H "Authorization: Bearer $COOLIFY_TOKEN" \
     "$COOLIFY_URL/api/v1/deployments/deploy?uuid=<app-uuid>"
```

## Docker Image Deployment (no git repo)

```
application action="create_dockerimage"
  project_uuid="<uuid>"
  environment_name="production"
  server_uuid="<uuid>"
  docker_image="nginx:latest"
  docker_registry="docker.io"
  health_check_path="/"
  health_check_interval=30
  health_check_retries=3
```

**Private registry** (credentials configured in Coolify dashboard):
```
application action="create_dockerimage"
  project_uuid="<uuid>"
  environment_name="production"
  server_uuid="<uuid>"
  docker_image="ghcr.io/org/app:latest"
  docker_registry="ghcr.io"
  health_check_path="/health"
```

## GitHub Actions Integration

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Coolify Deploy
        run: |
          curl -sf -H "Authorization: Bearer ${{ secrets.COOLIFY_TOKEN }}" \
               "${{ secrets.COOLIFY_URL }}/api/v1/deployments/deploy?uuid=${{ secrets.APP_UUID }}"
```

Required GitHub secrets: `COOLIFY_TOKEN`, `COOLIFY_URL`, `APP_UUID`

## Deployment Strategy Reference

| Strategy | When to Use |
|----------|-------------|
| Git push + auto-deploy | Default for most apps |
| Webhook by tag | Version-pinned releases, staging promotion |
| Webhook by UUID | CI/CD pipeline integration (specific app) |
| Docker image (`create_dockerimage`) | Pre-built images, registry-first workflow |
| `force_rebuild: true` | Cache corruption or dependency issues |
