---
name: teams-notifications
description: "Microsoft Teams MCP integration for agent-to-human notifications and bi-directional communication. Use when agents need to post progress updates, request approvals, or read user responses via Teams channels and chats."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Teams Notifications

Agent communication patterns via the Microsoft Teams MCP server (Microsoft Agent 365). Enables agents to post progress updates, request human approvals, and read responses — all through Teams channels and chats.

## MCP Server

| Field | Value |
|-------|-------|
| **URL** | `https://mcp.microsoft365.com/mcp` |
| **Type** | Remote MCP server (HTTP) |
| **Auth** | Microsoft Graph API — OAuth 2.0 with `McpServers.Teams.All` scope |
| **Platform** | Microsoft Agent 365 (Frontier preview) |
| **Status** | Preview — requires Microsoft Agent 365 Frontier preview access |

### Prerequisites

1. **Microsoft Agent 365 Frontier preview** enrollment
2. **App registration** in Microsoft Entra ID (Azure AD)
3. **Graph API permissions:** `McpServers.Teams.All` (delegated or application)
4. **Admin consent** for the registered app

## Available MCP Tools

Tool names follow `teams_<resource>_<action>`. Covers: chats, messages, channels, members, and team settings. Use tool discovery to list available tools at runtime.

## Agent Notification Patterns

### Progress Updates

```
Channel: Agent Updates (or project-specific channel)
Format:
  🔄 **Task:** TAS-42 — Add price filter component
  **Status:** In progress — implementing unit tests
  **Files changed:** 3 (PriceFilter.tsx, PriceFilter.test.tsx, index.ts)
  **ETA:** ~5 minutes
```

## Human-in-the-Loop Approval

1. **Post approval request** to the channel:
   ```
   ⏳ **Approval Required**
   Task: TAS-42 — Database migration adds `price_range` column
   Action: Run migration on production database

   Reply with:
   ✅ Approve — to proceed
   ❌ Reject — to stop
   Or reply with questions/comments
   ```
2. **Poll for response** — Read replies to determine the decision.
3. **Acknowledge** — Post confirmation of the action taken.

### Parsing Conventions

| Signal | Meaning |
|--------|---------|
| `✅` or "approve"/"yes" reply | Approved — proceed |
| `❌` or "reject"/"no" reply | Rejected — stop and report |
| `👀` reaction or "looking" reply | Acknowledged — user is reviewing |
| Detailed reply | Instructions or questions for the agent |
| `@mention` of agent | Direct command or question |

## Channel & Chat Conventions

### Threading Rules

- **Always reply in threads** — use message replies, not top-level posts for follow-ups
- **One thread per task** — keep all updates for a single task in one conversation thread
- **Include task ID** — every message references the tracker issue ID
- **Mark important messages** — use importance flags for approval requests

## Message Formatting

### Adaptive Cards

For richer formatting, use Adaptive Cards (JSON-based):

```json
{
  "type": "AdaptiveCard",
  "body": [
    { "type": "TextBlock", "text": "Approval Required", "weight": "Bolder", "size": "Medium" },
    { "type": "TextBlock", "text": "Task: TAS-42 — Database migration", "wrap": true }
  ],
  "actions": [
    { "type": "Action.Submit", "title": "Approve", "data": { "action": "approve" } },
    { "type": "Action.Submit", "title": "Reject", "data": { "action": "reject" } }
  ],
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.4"
}
```

Use Adaptive Cards for approval workflows when available — they provide structured input.

## Rate Limits

Microsoft Graph API: 50 messages/second per app per tenant; 10,000 individual API calls per 10 minutes.

**Best practices:**
- Batch updates into single messages rather than posting many small messages
- Cache team/channel/user IDs — don't look them up repeatedly

## Security Considerations

- **OAuth tokens** are managed by the MCP server — agents never see raw tokens
- **Scope minimization** — request only the Graph API permissions agents actually need
- **No secrets in messages** — never post tokens, passwords, or credentials in Teams messages

## Preview Limitations

The Teams MCP server is in Frontier preview — availability and tool surface may change without notice. Check [Microsoft Agent 365 documentation](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/) for the latest status.
