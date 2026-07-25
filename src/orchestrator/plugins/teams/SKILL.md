---
name: teams-notifications
description: "Microsoft Teams MCP integration for agent-to-human notifications and bi-directional communication. Use when agents need to post progress updates, request approvals, or read user responses via Teams channels and chats."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Teams Notifications

## MCP Server

URL: `https://mcp.microsoft365.com/mcp`. Auth: OAuth 2.0 (Azure AD, scopes: `Chat.ReadWrite`, `ChannelMessage.Send`).

## MCP Tools

Covers chats, messages, channels, members, and settings.

### Example MCP calls

Post a progress update:

```json
// tool: teams_messages_create
{ "channel_id": "channel-xyz", "body": "🔄 TAS-42 — In progress — implementing unit tests\nFiles: 3 (PriceFilter.tsx, test, index)" }
```

Read replies in thread:

```json
// tool: teams_messages_list_replies
{ "channel_id": "channel-xyz", "thread_id": "thread-abc", "limit": 50 }
```

## Human-in-the-Loop Approval

1. **Post approval request** — verify the response confirms message_id:

```json
// tool: teams_messages_create
{ "channel_id": "channel-xyz", "body": "⏳ Approval Required\nTask: TAS-42 — Run migration on production\nReply: Approve or Reject", "threading": { "start_thread": true } }
// → { "message_id": "msg-123", "thread_id": "thread-abc" }
```

   If post fails: retry once; if still failing, fall back to asking in chat only.

2. **Poll for response** (5s interval, 5 min timeout):

```js
const replies = await teams_messages_list_replies({ channel_id: channelId, thread_id: threadId, limit: 50 });
for (const r of replies || []) {
  if (/\b(approve|yes)\b/i.test(r.body)) return 'approved';
  if (/\b(reject|no)\b/i.test(r.body)) return 'rejected';
}
// Retry after 5s; timeout after 5 min → post escalation message
```

3. **Acknowledge** — Post confirmation of the action taken and close the thread.



## Channel & Chat Conventions

### Threading Rules

- Always reply in threads; one thread per task; include tracker issue ID in every message.

## Message Formatting

### Adaptive Cards and advanced payloads

