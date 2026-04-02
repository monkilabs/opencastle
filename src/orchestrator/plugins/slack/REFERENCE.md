> Parent: [SKILL.md](./SKILL.md)

Slack REFERENCE: authentication scopes, token setup, and MCP server environment variables.

Move security and auth details here to keep `SKILL.md` concise.
Last Updated: 2026-03-31

Reference: Slack scopes & MCP tools

## OAuth Scopes (recommended minimal sets)

- Bot (notifications): `chat:write`, `channels:read`, `conversations:history`, `users:read`
- Read-only: `channels:read`, `channels:history`, `im:read`

## MCP Tools (compact)

- `conversations_add_message` — `channel_id`, `payload`, `content_type`, `thread_ts`
- `conversations_history` — `channel_id`, `limit`
- `conversations_replies` — `channel_id`, `thread_ts`, `limit`
- `users_resolve` — `email|username`

## Token handling

- Store `SLACK_MCP_XOXB_TOKEN` in CI/env; rotate periodically; log token rotations in the observability log.
