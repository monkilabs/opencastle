````markdown
# Agent Performance Tracking

Tracks agent success rates across panel reviews and delegated tasks to inform model routing and panel reviewer selection.

## Data Sources

Performance data is collected automatically via NDJSON session logs:
- **All events:** `.opencastle/logs/events.ndjson` — unified log for all event types (sessions, delegations, reviews, panels, disputes), appended via `opencastle log`
- **Dashboard:** Run `npx opencastle convoy dashboard` to visualize agent performance

## Quick Queries

```bash
# Sessions per agent
jq -r 'select(.type == "session") | .agent' .opencastle/logs/events.ndjson | sort | uniq -c | sort -rn

# Success rate by agent
jq -r 'select(.type == "session") | [.agent, .outcome] | @tsv' .opencastle/logs/events.ndjson | sort | uniq -c

# Delegation tier distribution
jq -r 'select(.type == "delegation") | .tier' .opencastle/logs/events.ndjson | sort | uniq -c

# Failed delegations
jq 'select(.type == "delegation" and .outcome == "failed")' .opencastle/logs/events.ndjson
```

## Panel Review Performance

Panel review data is collected automatically in `.opencastle/logs/events.ndjson` with `type: "panel"` (appended by the panel runner after each review — see step 7 in the panel majority vote skill).

```bash
# Total panel reviews
jq 'select(.type == "panel")' .opencastle/logs/events.ndjson | wc -l

# Pass vs block rate
jq -r 'select(.type == "panel") | .verdict' .opencastle/logs/events.ndjson | sort | uniq -c

# Reviews by panel key
jq -r 'select(.type == "panel") | .panel_key' .opencastle/logs/events.ndjson | sort | uniq -c | sort -rn

# Reviews that required retries (attempt > 1)
jq 'select(.type == "panel" and .attempt > 1)' .opencastle/logs/events.ndjson

# Average SHOULD-FIX items per review
jq -s '[.[] | select(.type == "panel")] | if length > 0 then (map(.should_fix) | add) / length else 0 end' .opencastle/logs/events.ndjson
```

## Usage

Referenced by the **panel-majority-vote** skill for weight assignment:
- Agents with >80% success rate for similar reviews get a +1 weight bonus
- This file is the source of truth for that metric

````
