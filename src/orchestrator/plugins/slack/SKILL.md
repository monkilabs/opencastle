---
name: slack-notifications
description: "Slack MCP integration for agent-to-human notifications and bi-directional communication. Use when agents need to post progress updates, request approvals, or read user responses via Slack channels and threads."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Slack Notifications

Agent communication patterns via the Slack MCP server. Enables agents to post progress updates, request human approvals, and read responses — all through Slack channels and threads.

## MCP Server

| Field | Value |
|-------|-------|
| **Package** | [`@kazuph/mcp-slack`](https://www.npmjs.com/package/@kazuph/mcp-slack) |
| **Type** | stdio (spawned via `npx -y @kazuph/mcp-slack`) |
| **Auth** | Bot token (`xoxb-…`) via `SLACK_MCP_XOXB_TOKEN` env var |
| **Extra env** | `SLACK_MCP_ADD_MESSAGE_TOOL=true` — enables `conversations_add_message` |

### Authentication

Use a **bot token** (`SLACK_MCP_XOXB_TOKEN`). For message search, a user token (`xoxp-…`) via `SLACK_MCP_XOXP_TOKEN` is required instead.

**Bot Token Scopes:**

| Scope | Purpose |
|-------|---------|
| `chat:write` | Post messages and replies |
| `channels:read`, `channels:history` | List and read public channels |
| `groups:read`, `groups:history` | List and read private channels |
| `im:read`, `im:history`, `mpim:read`, `mpim:history` | DMs and group DMs |
| `users:read`, `users:read.email` | Look up user profiles and emails |
| `channels:manage` | Create/rename channels (optional) |

## Available MCP Tools

### Channel Management

`channels_list`, `conversations_create`, `conversations_rename`, `conversations_set_topic`, `conversations_invite`

### Messaging

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `conversations_add_message` | Post a message to a channel or thread | `channel_id`, `payload`, `content_type` (`text/markdown`), `thread_ts` |
| `conversations_history` | Read recent messages from a channel | `channel_id`, `limit` (e.g. `1d`, `50`) |
| `conversations_replies` | Get replies in a thread | `channel_id`, `thread_ts`, `limit` |
| `conversations_search_messages` | Search messages across channels | `search_query`, `filter_in_channel`, `filter_date_*` |

### Users

`users_resolve` — look up a user by name or email; returns user ID for mentions.

### Key Differences from Slack Web API

- Tool names use `conversations_*` pattern, not `chat.postMessage` etc.
- Message body is sent via `payload` parameter, not `text`
- Message posting is **disabled by default** — requires `SLACK_MCP_ADD_MESSAGE_TOOL=true` env var
- `limit` on history/replies accepts time ranges (`1d`, `7d`, `30d`) or message counts (`50`)
- No reaction tools or canvas tools available via this MCP server

## Agent Notification Patterns

### Progress Updates

```
Channel: #agent-updates (or project-specific channel)
Format:
  🔄 **Task:** TAS-42 — Add price filter component
  **Status:** In progress — implementing unit tests
  **Files changed:** 3 (PriceFilter.tsx, PriceFilter.test.tsx, index.ts)
  **ETA:** ~5 minutes
```

## Bi-Directional Communication

### Dual-Channel Approval Pattern

Approval requests are always **dual-channel** — posted to Slack AND asked in the chat window. The first response wins.

```
Agent needs approval
 ├─→ Posts to Slack channel/thread
 │     → User replies in Slack
 │     → Agent polls & picks it up ──────┐
 │                                       ▼
 │                                  Agent acts
 │                                       ▲
 └─→ Asks in VS Code chat                │
       → User replies here ──────────────┘
       (immediate, no polling needed)
```

### Approval Flow

1. **Post to Slack** with a structured approval request:
   ```
   ⏳ **Approval Required**
   Task: TAS-42 — Database migration adds `price_range` column
   Action: Run migration on production database

   Reply in this thread with:
   ✅ "approved" — Approve and proceed
   ❌ "rejected" — Reject and stop
   💬 Or reply with questions
   ```

2. **Ask in chat** — Yield to the user with the same question so they can respond directly.

3. **If the user responds in chat** — Post confirmation to the Slack thread: `✅ Approved via VS Code chat. Proceeding.`

4. **If waiting for Slack reply** — Poll every 30 seconds using `conversations_replies` with the message's `thread_ts`. Continue independent subtasks between polls.

5. **If session ends before reply** — Save to checkpoint with channel, thread ID, question, and timestamp. The next session's `on-session-start` hook checks for replies.

### Parsing Conventions

| Signal | Meaning |
|--------|---------|
| Thread reply with "approved" / "yes" / "go" | Approved — proceed |
| Thread reply with "rejected" / "no" / "stop" | Rejected — stop and report |
| Thread reply with "reviewing" / "looking" | Acknowledged — user is reviewing |
| Thread reply with detailed text | Instructions or questions |
| `@agent` mention | Direct command or question for the agent |

> **Note:** Reactions are not available via the Slack MCP server. Use thread replies for all approval workflows.

## Channel & Thread Conventions

Project-specific channel mappings are defined in `.opencastle/stack/notifications-config.md`. Always prefer channel IDs from the config over hardcoded names.

### Threading Rules

- **Always thread replies** — never post top-level messages for follow-ups
- **One thread per task** — keep all updates for a single task in one thread
- **Include task ID** — every message references the tracker issue ID
- **Pin important threads** — pin approval requests and blocking issues

## Rate Limits

Write ops are Tier 2 (20/min); read ops Tier 3 (50/min). Best practices:
- Batch updates into single messages rather than posting many small messages
- Use threads to consolidate related updates
- Cache channel/user IDs — don't look them up repeatedly

## Security Considerations

- **Bot tokens** are passed via `SLACK_MCP_XOXB_TOKEN` env var — never hardcode in config files or commit to git
- **Scope minimization** — request only the scopes agents actually need
- **No secrets in messages** — never post tokens, passwords, or credentials in Slack messages
