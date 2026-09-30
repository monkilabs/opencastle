# OpenCastle for teams

> Back to [README](../README.md) · Status: proposal, September 2026

A single developer's assistant config is a solved problem. A team's is not.
Teams run several assistants side by side, each reads its own format, and
nobody owns the result: nobody reviews it, nobody notices when it drifts, and
nobody can say which MCP servers — code that runs with every developer's
credentials — the team's agents actually launch.

That is the gap OpenCastle should close. This document records what shipped
toward it and what should come next, in order of leverage.

## Why now

- **AI amplifies whatever practices a team already has.** Google's 2025 DORA
  report found AI use linked to higher delivery throughput *and* rising
  instability, and named seven capabilities that decide which way it goes —
  among them a clear and communicated AI stance, strong version control, small
  batches and quality internal platforms. Assistant config is the most concrete
  form of "a clear AI stance" there is, and it already lives in version control.
  ([DORA 2025](https://blog.google/technology/developers/dora-report-2025/),
  [the seven capabilities](https://cusy.io/en/blog/dora-report-2025.html))
- **MCP servers are the agents' supply chain.** The OWASP Top 10 for Agentic
  Applications (December 2025) lists agentic supply-chain vulnerabilities, tool
  misuse, and identity and privilege abuse among its ten risks.
  ([OWASP](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026))
- **The formats are converging.** `AGENTS.md` and MCP moved to the Linux
  Foundation's Agentic AI Foundation in December 2025, and Agent Skills became an
  open standard the same month. Fewer dialects to compile to, and a stable target
  for a team standard.
  ([AAIF](https://openai.com/blog/agentic-ai-foundation),
  [Agent Skills](https://simonwillison.net/2025/dec/19/agent-skills))

## Shipped

| Change | Why it matters to a team |
| --- | --- |
| `sync --check` annotates drifted files on GitHub Actions and writes a run summary | Drift is seen by the PR author and reviewer, not only by whoever opens the job log |
| Every MCP default pinned, project-local (`npx --no`), or the vendor's remote server | Every laptop and CI run starts the same server version; upgrades are a reviewable diff |
| Three defaults replaced: two packages that were never published, one unpublished from npm | The servers start at all — and nobody can claim the vacated name |
| Remote servers in `.mcp.json` carry `"type": "http"` | Claude Code loads them; before, it read them as stdio servers with no command |
| `sync` moves entries still exactly as an earlier release wrote them | Existing installs get fixes without anyone's edits being overwritten |
| `doctor` audits what every MCP config launches | Covers servers the team added by hand, with a remedy per finding |
| Weekly `mcp:check` workflow | A pin that disappears from the registry turns a check red here first |

## Next, in order of leverage

### 1. A shared baseline across repositories

Most teams have tens of repositories and configure each one separately today.

```jsonc
// .opencastle/config.json
{ "extends": "@acme/opencastle-baseline@1.4.0" }
```

The baseline — an npm package or a git ref — carries the organisation's
instructions, skills, workflow templates and approved MCP servers; each
repository layers its own on top in `.opencastle/`. The resolved baseline
version is recorded in the manifest, so `sync --check` fails when a repository
falls behind, and a baseline change reaches every repository as one PR each.

### 2. An MCP allowlist

The baseline declares which servers may run, from where, at which versions.
`doctor` and `sync --check` fail on anything else, including servers added by
hand. Beyond pinning: flag secrets written inline in a committed config, and
prefer remote servers with OAuth — per-person identity, nothing shared in `.env`
— wherever the vendor offers one.

### 3. Review the meaning, not the generated files

A source change regenerates many files across several assistants. On a pull
request, `sync --check` should summarise what changes for each assistant in
words — "Cursor gains two rules; the Claude Code *testing-workflow* skill
changed; Linear's server moves to 2.1.0" — so reviewers review behaviour. Ship
a `CODEOWNERS` template for `.opencastle/` so the standard has an owner.

### 4. Instruction health

Context engineering applies to the team's own instructions too. `doctor` should
flag rot and bloat:

- file paths and package scripts named in instructions that no longer exist;
- always-loaded context per assistant above a budget, with the files that
  contribute most — the fix is usually moving detail into an on-demand skill.

### 5. Onboarding in one command

`opencastle explain` prints, for each assistant, what a new teammate's agent
will load and why: which rules, which skills and when they trigger, which MCP
servers and what they can reach.

### 6. Adoption signals without surveillance

Opt-in, team-level only, and never per person — individual metrics invite
gaming ([DX](https://getdx.com/research/measuring-ai-code-assistants-and-agents/)).
From git alone: the share of merged PRs with an AI co-author trailer, PR size
and time to merge, compared across the date a baseline change landed. Use it
beside DORA delivery metrics, not instead of them.

A caution from this codebase's own history: an earlier "intelligence suite" was
removed because it wrote ledgers nobody read. This one ships only with a
reader — the PR comment or the run summary — and only answers a question a team
lead actually asks.

### 7. Standards first

Write `AGENTS.md` and Agent Skills for every assistant that reads them, and keep
per-assistant dialects only where an assistant needs one. Fewer generated files
means less to review and less to drift.

## Open questions to verify

- A pinned `npx` server pins the server's version, not its dependency tree:
  npx resolves those per machine with no lockfile. Closing that gap means
  installing servers as project dev-dependencies (and launching them with
  `npx --no`) or preferring remote servers — worth offering as a strict mode.
- `previousMcpConfigs` records the defaults this tool's plugin files have held
  since the plugins moved to their current layout. Entries from older releases
  in a different shape are treated as edited: `doctor` says so and names the
  remedy (delete the entry and `sync --force`), but they are not moved
  automatically.
- Figma's remote server lists the clients it supports; OpenCode, Windsurf and
  Antigravity are not on that list. Those targets may need Figma's desktop
  server (`http://127.0.0.1:3845/mcp`) instead, which needs a per-target config.

- The Windsurf, Codex and Antigravity MCP outputs should be checked against each
  vendor's current documentation, the way the Claude Code shape was: remote
  servers may need a different key there, and Codex CLI configures MCP servers in
  TOML.
- Generated env blocks use `${VAR}`. Confirm how each assistant treats an unset
  variable, and whether `${VAR:-}` (which Claude Code supports) is the safer
  default.

## How we will know it works

- Share of an organisation's repositories whose `sync --check` is green on the
  default branch.
- Time from a baseline release to every repository synced.
- Distinct versions of each MCP server running across repositories — the target
  is one.
- `doctor` findings per repository, trending to zero.
