# Logging Is Mandatory

> **⛔ HARD GATE — Constitution rule #6.** Every agent MUST log every session to `.opencastle/logs/events.ndjson`. No exceptions. No threshold. No "too small to log."

- Log **before yielding** to the user — logging is the LAST action before responding.
- Log **per task**, not per conversation. Multiple tasks = multiple records.
- Never batch-log retrospectively across sessions.
- Use `opencastle log --type session ...` for session records.
- Verify the append succeeded: `tail -1 .opencastle/logs/events.ndjson`.

See the **observability-logging** skill for full CLI commands, record schemas, and the pre-response checklist.
