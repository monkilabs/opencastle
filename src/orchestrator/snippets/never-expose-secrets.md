# Never Expose Secrets

> **HARD GATE — Constitution rule 1.** No tokens, keys, passwords, or connection strings in code, logs, commits, or terminal output. Use environment variables.

## What to scan

- AWS keys (AKIA...), API tokens (sk-..., ghp_...), private keys, database URIs
- Hardcoded password, secret, api_key, apiKey, token assignments (not just references)
- .env file contents copied into source files
- Base64-encoded secrets

## On detection

- **BLOCK immediately** — flag the specific file and line number.
- Re-delegate with explicit instruction to use environment variables.
- If already committed, **rotate immediately** — git history is permanent.

## Exceptions

- Test fixtures with obviously fake values (e.g., sk-test-1234567890)
- Documentation examples with placeholder values (e.g., YOUR_API_KEY_HERE)
- Pattern matches inside comments that are clearly explanatory
