---
name: slack-notifications
description: "Slack MCP integration for agent-to-human notifications and bi-directional communication. Use when agents need to post progress updates, request approvals, or read user responses via Slack channels and threads."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Slack Notifications

Package `@kazuph/mcp-slack` (stdio). Docs: https://api.slack.com/docs. Channel mappings: `.opencastle/stack/notifications-config.md`

## Setup

- `SLACK_MCP_XOXB_TOKEN` — bot token, stored in CI/env, rotated periodically.
- **`SLACK_MCP_ADD_MESSAGE_TOOL=true` is required to post at all** — write support is off by default.
- Minimal bot scopes for notifications: `chat:write`, `channels:read`, `conversations:history`, `users:read`. Read-only: `channels:read`, `channels:history`, `im:read`.

## Rate limits

Write **20/min**, read **50/min**. Batch updates instead of per-step chatter, thread rather than posting new messages, and cache channel/user IDs — repeated `users_resolve` lookups burn the read budget.

## Tools

- `conversations_add_message` — `channel_id`, `payload`, `content_type`, `thread_ts`
- `conversations_history` — `channel_id`, `limit`
- `conversations_replies` — `channel_id`, `thread_ts`, `limit`
- `users_resolve` — `email|username`

Check the response for `ok`; a failed post returns `error` rather than throwing.

## Approvals are dual-channel

Post to Slack **and** ask in chat. First response wins.

1. Post `⏳ Approval Required — TAS-42: <action>` with reply instructions, keeping the returned `thread_ts`.
2. Ask the same question in chat. A chat answer wins → post the confirmation into the Slack thread.
3. Otherwise poll `conversations_replies` on that thread every **30s, timing out at 10 min**, matching approved/yes/go vs rejected/no/stop.
4. **If the session ends before a reply, write a checkpoint** with channel, thread ID, question, and timestamp. The next session's `on-session-start` hook picks up the reply.

Always thread; one thread per task; include the tracker issue ID in every message. Never put secrets in a message body.
