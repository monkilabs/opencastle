---
name: hetzner-cloud
description: "Provisions Hetzner Cloud servers, volumes, private networks, and firewalls via the hcloud CLI and the Pulumi/Terraform hcloud provider; plans CAX/arm64 sizing; configures backups, snapshots, and DR rebuilds. Use when creating or resizing Hetzner servers, attaching volumes, configuring private networks or firewalls, choosing server types, scripting hcloud commands, or authoring hcloud IaC resources."
---

# Hetzner Cloud

Facts that drift (prices, SKUs, locations, limits) go stale — **prefer retrieval over pre-training**: `hcloud server-type list -o json`, `hcloud location list`, docs.hetzner.com. Everything below is behavior, not price sheets. If the project documents a topology (e.g. `docs/architecture/`), read it before provisioning anything.

## Provisioning Workflow

1. **Pick type + location together** — CAX (Ampere arm64, best RAM/€) exists **only in EU DCs** (fsn1/nbg1/hel1); verify with `hcloud server-type list`. arm64 requires multi-arch container images end-to-end.
   - Checkpoint: `hcloud server-type describe <type>` shows the target location.
2. **Create network + firewall before servers** — attach at create time; firewall via label selector (`role=web`) scales better than per-server IDs.
   - Checkpoint: firewall rules list SSH restricted to admin IPs, never `0.0.0.0/0`.
3. **Create server with cloud-init user-data** — runs once at first boot only.
   - Recovery: broken cloud-init → don't patch by hand; fix the template, `server rebuild` (keeps IPs) or replace via IaC.
4. **Attach volumes, then mount explicitly** — see Volumes below.
   - Checkpoint: mount survives reboot (`fstab` entry, not just `automount`).
5. **Enable protection on stateful resources** — `hcloud server enable-protection <s> delete rebuild` + same for volumes.
   - Gate: protection verified via `hcloud server describe` before real data lands.

## Non-Obvious Behaviors

### Networking
- **Cloud Firewalls filter ONLY the public interface.** Private-network traffic is never touched by them — segment the private net with host firewalls (`ufw`) or not at all. This is the most common Hetzner security misconception.
- Private network **MTU is 1450**, not 1500 — override in Docker (`daemon.json` `"mtu": 1450`) and any overlay/VPN on top, or suffer silent large-packet stalls.
- Private networks are **not encrypted** — treat as shared fabric, keep TLS for sensitive cross-node traffic.
- Network zones (e.g. `eu-central` = fsn1/nbg1/hel1) span DCs — cross-DC private traffic works and is free.
- **Floating IPs need manual OS config** (netplan alias); primary IPs configure themselves. Floating IP ≠ instant failover without host-side automation.
- IPv4 primary IPs bill separately and **survive server deletion** unless `auto_delete` is set — orphaned IPs keep billing.

### Servers & billing
- Hourly billing capped at the monthly price. Deleting a server stops its billing but **volumes, snapshots, and primary IPs keep billing** — sweep for orphans after teardowns.
- `change-type` (resize) requires **ACPI shutdown first** (`hcloud server shutdown`, not `poweroff` — that's a hard cut risking fs damage). CPU/RAM can downgrade later only with `--keep-disk`; disk never shrinks.
- `server rebuild` wipes the disk but **keeps all IPs** — the fast DR path when the root cause is software.
- 20 TB egress included per cloud server; ingress + private-net traffic free.
- Metadata endpoint: `http://169.254.169.254/hetzner/v1/metadata` (useful in cloud-init to self-discover private IP).

### Volumes
- **Location-bound** — attach only within the same DC; a "move to another region" is snapshot-less (rsync) by design.
- **Grow-only, online** — after `hcloud volume resize`, run `resize2fs`/`xfs_growfs` yourself; nothing automatic.
- `automount` mounts under `/mnt/<volume-name>` via udev — fine for experiments, wrong for services. Use an explicit `fstab` entry (`discard,nofail`) at a stable path; `nofail` so a detached volume doesn't hang boot.

### Backups vs snapshots
| | Backups | Snapshots |
|---|---|---|
| Trigger | Automatic daily, 7 rolling | Manual |
| Cost | +20% of server price | Per GB stored |
| Survives server deletion | **No** | Yes |
| Can seed a new server | No (convert to snapshot first) | Yes (`--image <snapshot-id>`) |

Backup→snapshot conversion exists — do it before deleting a server whose history matters. Neither replaces app-level data exports — Hetzner backups are crash-consistent block copies, not application backups.

### IaC (Pulumi / Terraform `hcloud` provider)
- **Changing `userData` replaces the server.** Deliberate for cattle; catastrophic for stateful nodes. Keep volatile config out of cloud-init (runtime config management owns it) and treat any cloud-init diff as a planned node replacement — or `ignoreChanges: ["userData"]` on pet servers.
- `serverType` change is a **replacement** in IaC even though the console/CLI resizes in place. To resize without replacement: `hcloud server change-type` manually, then refresh state + update code.
- Pulumi: `firewallIds` wants numbers — `firewall.id.apply(Number)`. Inline `networks` on the Server conflicts with a separate `ServerNetwork` resource — pick one.
- `backups: true` toggles in place (safe anytime). IaC-level `protect` only blocks the IaC tool — set **hcloud-side** delete/rebuild protection too; they guard different doors.
- Auth: `HCLOUD_TOKEN` env (CI/agents) — per-project tokens, read-write only where needed.

## CLI Patterns

```bash
export HCLOUD_TOKEN=...                       # stateless auth for CI/agents; `hcloud context` for humans
hcloud server list -o columns=name,status,ipv4,type -o noheader
hcloud server ssh my-server                   # no IP lookup, uses your agent keys
hcloud server create-image my-server --type snapshot --description "pre-change $(date +%F)"
hcloud volume list -o json | jq -r '.[] | select(.server==null) | .name'   # orphaned volumes
hcloud primary-ip list -o json | jq -r '.[] | select(.assignee_id==null) | .ip'  # orphaned IPs
hcloud server shutdown my-server \
  && hcloud server change-type my-server --server-type cax31 --keep-disk \
  && hcloud server poweron my-server          # in-place upgrade, downgrade-capable
```

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Trusting Cloud Firewall for private-net isolation | Host-level `ufw`; Cloud Firewall covers public interface only |
| SSH open to `0.0.0.0/0` | Admin-IP allowlist in firewall rules (or SSH over tunnel only) |
| `poweroff` before resize/maintenance | `shutdown` (ACPI graceful), then operate |
| Editing `userData` on a stateful server in IaC | Post-boot config mgmt; `ignoreChanges` or planned replacement |
| Relying on `automount` for service data | Explicit `fstab` (`discard,nofail`) at a stable mount point |
| Assuming CAX exists in every location | EU-only; check `server-type list` before designing |
| Deleting servers and assuming cleanup | Sweep volumes/snapshots/primary IPs — they persist and bill |
| Hetzner Backups as the only backup | App-level exports to object storage; backups die with the server |

## References

| Resource | Purpose |
|----------|---------|
| <https://docs.hetzner.com/cloud/> | Authoritative, current limits/prices |
| <https://www.pulumi.com/registry/packages/hcloud/> | Pulumi provider resource reference |
| <https://registry.terraform.io/providers/hetznercloud/hcloud/latest/docs> | Terraform provider reference |
| **deployment** capability skill | Platform-level deploy/env-var/cron patterns |
