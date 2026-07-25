# Agent Session Logs

Append-only NDJSON log for agent activity tracking. All events are stored in a single file with a `type` discriminator — one JSON object per line.

## File

| File | Description |
|------|-------------|
| `events.ndjson` | All agent events, sorted by timestamp |

## Type Discriminator

Each record includes a `type` field that identifies the event kind:

| `type` value | Appended by | Description |
|-------------|-------------|-------------|
| `session` | All agents (via self-improvement protocol) | Session record |
| `delegation` | Team Lead agent | Delegation record |
| `review` | Team Lead (via fast-review skill) | Fast review record |
| `panel` | Panel runner (via panel majority vote skill) | Panel record |
| `dispute` | Team Lead (via dispute protocol) | Dispute record |

## CLI Usage

Use `opencastle log` to append events. Agents should call this instead of raw `echo` commands.

```sh
# Session
opencastle log --type session --agent Developer --model "$MODEL" \
  --task "PRJ-57: Fix header component" --outcome success --duration_min 12 \
  --files_changed 5 --retries 0

# Delegation
opencastle log --type delegation --session_id feat/prj-57 --agent Developer \
  --model "$MODEL" --tier standard --mechanism sub-agent \
  --outcome success --phase 2 --file_partition "src/components/,src/pages/"

# Review
opencastle log --type review --tracker_issue PRJ-42 --agent Developer \
  --reviewer_model "$MODEL" --verdict pass --attempt 1 \
  --issues_critical 0 --issues_major 0 --issues_minor 2 \
  --confidence high --escalated false

# Panel
opencastle log --type panel --panel_key auth-review --verdict pass \
  --pass_count 3 --block_count 0 --must_fix 0 --should_fix 5 \
  --reviewer_model "$MODEL" --weighted false --attempt 1

# Dispute
opencastle log --type dispute --dispute_id DSP-001 --tracker_issue PRJ-42 \
  --priority high --trigger panel-3x-block --implementing_agent Developer \
  --reviewing_agents "Reviewer,Panel (3x)" --total_attempts 6 --status pending
```

Run `opencastle log --help` for full options.

## Session Record (`type: "session"`)

```json
{
  "type": "session",
  "timestamp": "2026-02-25T14:30:00Z",
  "agent": "Developer",
  "model": "<model reported by the assistant>",
  "task": "PRJ-57: Fix header component",
  "tracker_issue": "PRJ-57",
  "outcome": "success",
  "duration_min": 12,
  "files_changed": 5,
  "retries": 0,
  "lessons_added": [],
  "discoveries": []
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"session"` |
| `timestamp` | `string` | Yes | ISO 8601 datetime (YYYY-MM-DDTHH:MM:SSZ) |
| `agent` | `string` | Yes | Agent name from the registry |
| `model` | `string` | Yes | Model used — whatever the assistant reported |
| `task` | `string` | Yes | Short description of the task performed |
| `tracker_issue` | `string` | No | Issue ID if applicable (e.g., `PRJ-57`) |
| `outcome` | `string` | Yes | `success`, `partial`, `failed` |
| `duration_min` | `number` | No | Estimated session duration in minutes |
| `files_changed` | `number` | No | Number of files created/modified |
| `retries` | `number` | No | Number of retried operations |
| `lessons_added` | `string[]` | No | Lesson IDs added (e.g., `["LES-015"]`) |
| `discoveries` | `string[]` | No | Issues discovered (issue IDs or KNOWN-ISSUES IDs) |

## Delegation Record (`type: "delegation"`)

```json
{
  "type": "delegation",
  "timestamp": "2026-02-25T14:30:00Z",
  "session_id": "feat/prj-57",
  "agent": "Developer",
  "model": "<model reported by the assistant>",
  "tier": "fast",
  "mechanism": "sub-agent",
  "tracker_issue": "PRJ-57",
  "outcome": "success",
  "retries": 0,
  "phase": 2,
  "file_partition": ["src/components/", "src/pages/"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"delegation"` |
| `timestamp` | `string` | Yes | ISO 8601 datetime (YYYY-MM-DDTHH:MM:SSZ) |
| `session_id` | `string` | Yes | Branch name or feature identifier |
| `agent` | `string` | Yes | Agent name delegated to |
| `model` | `string` | Yes | Model used |
| `tier` | `string` | Yes | `economy`, `fast`, `standard`, `quality`, `premium` |
| `mechanism` | `string` | Yes | `sub-agent` or `background` |
| `tracker_issue` | `string` | No | Issue ID |
| `outcome` | `string` | Yes | `success`, `partial`, `failed`, `redirected` |
| `retries` | `number` | No | Times re-delegated |
| `phase` | `number` | No | Execution phase number |
| `file_partition` | `string[]` | No | Directories/files assigned |

## Fast Review Record (`type: "review"`)

```json
{
  "type": "review",
  "timestamp": "2026-02-28T14:30:00Z",
  "tracker_issue": "PRJ-42",
  "agent": "Developer",
  "reviewer_model": "<model reported by the assistant>",
  "verdict": "pass",
  "attempt": 1,
  "issues_critical": 0,
  "issues_major": 0,
  "issues_minor": 2,
  "confidence": "high",
  "escalated": false,
  "duration_sec": 45
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"review"` |
| `timestamp` | `string` | Yes | ISO 8601 datetime (YYYY-MM-DDTHH:MM:SSZ) |
| `tracker_issue` | `string` | No | Issue ID if applicable |
| `agent` | `string` | Yes | Agent whose output was reviewed |
| `reviewer_model` | `string` | Yes | Model used for the reviewer — whatever the assistant reported |
| `verdict` | `string` | Yes | `pass` or `fail` |
| `attempt` | `number` | Yes | Review attempt number (1, 2, or 3) |
| `issues_critical` | `number` | Yes | Count of critical severity issues |
| `issues_major` | `number` | Yes | Count of major severity issues |
| `issues_minor` | `number` | Yes | Count of minor severity issues |
| `confidence` | `string` | Yes | Reviewer self-reported confidence: `low`, `medium`, `high` |
| `escalated` | `boolean` | Yes | Whether this review triggered escalation to panel |
| `duration_sec` | `number` | No | Review duration in seconds |

## Panel Record (`type: "panel"`)

```json
{
  "type": "panel",
  "timestamp": "2026-02-25T14:30:00Z",
  "panel_key": "instruction-refactoring",
  "verdict": "pass",
  "pass_count": 3,
  "block_count": 0,
  "must_fix": 0,
  "should_fix": 5,
  "reviewer_model": "<model reported by the assistant>",
  "weighted": false,
  "attempt": 1,
  "tracker_issue": "PRJ-57",
  "artifacts_count": 14,
  "report_path": ".opencastle/logs/panel/instruction-refactoring.md"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"panel"` |
| `timestamp` | `string` | Yes | ISO 8601 datetime (YYYY-MM-DDTHH:MM:SSZ) |
| `panel_key` | `string` | Yes | Filesystem-safe panel identifier |
| `verdict` | `string` | Yes | `pass` or `block` |
| `pass_count` | `number` | Yes | Number of reviewers who voted PASS |
| `block_count` | `number` | Yes | Number of reviewers who voted BLOCK |
| `must_fix` | `number` | Yes | Total MUST-FIX items across all reviewers |
| `should_fix` | `number` | Yes | Total SHOULD-FIX items across all reviewers |
| `reviewer_model` | `string` | Yes | Model used for reviewers |
| `weighted` | `boolean` | Yes | Whether performance-weighted voting was applied |
| `attempt` | `number` | Yes | Attempt number (1 = first try) |
| `tracker_issue` | `string` | No | Issue ID if applicable |
| `artifacts_count` | `number` | No | Number of artifacts reviewed |
| `report_path` | `string` | No | Path to the full panel report |

## Dispute Record (`type: "dispute"`)

```json
{
  "type": "dispute",
  "timestamp": "2026-02-28T16:00:00Z",
  "dispute_id": "DSP-001",
  "tracker_issue": "PRJ-42",
  "priority": "high",
  "trigger": "panel-3x-block",
  "implementing_agent": "Developer",
  "reviewing_agents": ["Reviewer", "Panel (3x)"],
  "total_attempts": 6,
  "est_tokens_spent": 120000,
  "status": "pending",
  "resolution_option_chosen": null,
  "resolved_at": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"dispute"` |
| `timestamp` | `string` | Yes | ISO 8601 datetime when dispute was created |
| `dispute_id` | `string` | Yes | Dispute ID (e.g., `DSP-001`) |
| `tracker_issue` | `string` | No | Issue ID if applicable |
| `priority` | `string` | Yes | `critical`, `high`, `medium`, `low` |
| `trigger` | `string` | Yes | `panel-3x-block`, `approach-conflict`, `criteria-conflict`, `architectural-ambiguity`, `external-dependency` |
| `implementing_agent` | `string` | Yes | Agent that attempted the implementation |
| `reviewing_agents` | `string[]` | Yes | Agents that reviewed (e.g., `["Reviewer", "Panel (3x)"]`) |
| `total_attempts` | `number` | Yes | Sum of fast review + panel attempts |
| `est_tokens_spent` | `number` | No | Estimated tokens spent across all attempts |
| `status` | `string` | Yes | `pending`, `resolved`, `deferred` |
| `resolution_option_chosen` | `string` | No | Which option the human chose (null if pending) |
| `resolved_at` | `string` | No | ISO 8601 datetime when resolved (null if pending) |
