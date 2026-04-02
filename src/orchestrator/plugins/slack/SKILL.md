---
name: slack-notifications
description: "Slack MCP integration for agent-to-human notifications and bi-directional communication. Use when agents need to post progress updates, request approvals, or read user responses via Slack channels and threads."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Slack Notifications

## MCP Server

Package: `@kazuph/mcp-slack` (stdio). Auth: `SLACK_MCP_XOXB_TOKEN` env var. Enable `SLACK_MCP_ADD_MESSAGE_TOOL=true`.

See [REFERENCE.md](REFERENCE.md) for OAuth scopes and token setup.

## Agent Notification Patterns

### Progress Updates

```
🔄 TAS-42 — In progress — implementing unit tests
Files: 3 (PriceFilter.tsx, test, index) | ETA: ~5 min
```

### MCP invocation example

Post an approval request:

```js
const res = mcp_slack_conversations_add_message({
  channel: 'C012345',
  text: '⏳ Approval Required — TAS-42: Run DB migration?',
  thread_ts: null
});
if (!res?.ok) throw new Error('Slack post failed: ' + res?.error);
```

## Bi-Directional Communication

Approval requests are **dual-channel** — post to Slack AND ask in chat. First response wins.

1. **Post to Slack:**
   ```
   ⏳ Approval Required — TAS-42: Run DB migration
   Reply: ✅ approved | ❌ rejected | 💬 questions
   ```

2. **Ask in chat** with the same question.

3. **Chat response wins** → post confirmation to Slack thread.

4. **Waiting for Slack** → poll thread:

```js
// Poll for approval reply (30s interval, 10 min timeout)
const replies = mcp_slack_conversations_replies({ channel: 'C012345', ts: threadTs, limit: 20 });
for (const msg of replies?.messages || []) {
  if (/\b(approved|yes|go)\b/i.test(msg.text)) return 'approved';
  if (/\b(rejected|no|stop)\b/i.test(msg.text)) return 'rejected';
}
// Retry after 30s; timeout after 10 min
```

5. **If session ends before reply** — Save to checkpoint with channel, thread ID, question, and timestamp. The next session's `on-session-start` hook checks for replies.



## Conventions

Project-specific channel mappings: `.opencastle/stack/notifications-config.md`. Always thread replies; one thread per task; include tracker issue ID.

## Rate Limits

Write: 20/min; Read: 50/min. Batch updates; use threads; cache channel/user IDs.

See [REFERENCE.md](REFERENCE.md) for security guidelines.
