> Parent: [SKILL.md](./SKILL.md)

# Teams Reference (REFERENCE.md)

Last Updated: 2026-03-31

## Adaptive Cards

Use this file for canonical Adaptive Card payloads used by approval workflows.

Example Approval card (structured submit):

```json
{
  "type": "AdaptiveCard",
  "body": [
    { "type": "TextBlock", "text": "Approval Required", "weight": "Bolder", "size": "Medium" },
    { "type": "TextBlock", "text": "Task: <ID> — <Short description>", "wrap": true }
  ],
  "actions": [
    { "type": "Action.Submit", "title": "Approve", "data": { "action": "approve" } },
    { "type": "Action.Submit", "title": "Reject", "data": { "action": "reject" } }
  ],
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.4"
}
```

## Rate Limits

- Graph API suggestions: cache IDs, batch messages, and avoid per-user repeated lookups. Specific tenant limits may vary.

## Security Notes

- Keep scopes minimal. If the integration needs approve/reject, delegated user consent is preferable to application-level broad scopes.
- Never include secrets in message bodies. Use the MCP server to mediate tokens.