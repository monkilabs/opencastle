# Base Output Contract

Every specialist agent Output Contract MUST end with these standard items (in addition to domain-specific items above them):

- **Observability Logged** — Confirm ALL applicable log records were appended to `events.ndjson` (Constitution rule #6):
  - `--type session` — ALWAYS (every agent, every session)
  - `--type delegation` — if delegations occurred (Team Lead only)
  - `--type review` — if fast reviews occurred
  - `--type panel` — if panel reviews occurred
  - `--type dispute` — if disputes were created
- **Discovered Issues** — Pre-existing bugs or anomalies found during work, with tracking action taken per the [Discovered Issues Policy](discovered-issues-policy.md)
- **Lessons Applied** — Lessons from `.opencastle/LESSONS-LEARNED.md` that influenced this work, and any new lessons added

Agents reference this contract with: `See [Base Output Contract](../snippets/base-output-contract.md) for the standard closing items.`
