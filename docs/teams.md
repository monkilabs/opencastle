# OpenCastle for teams

> Back to [README](../README.md) · Status: first release shipped, September 2026 ·
> How to use it: [opencastle.dev/docs/teams](https://www.opencastle.dev/docs/teams/)

A single developer's assistant config is a solved problem. A team's is not.
Teams run several assistants side by side, each reads its own format, and
nobody owns the result: nobody reviews it, nobody notices when it drifts, and
nobody can say which MCP servers — code that runs with every developer's
credentials — the team's agents actually launch.

That is the gap OpenCastle should close. This document records what shipped
toward it and what is still open, in order of leverage. The guide to using what
shipped is on the website; this is the record of decisions and gaps.

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
| **Shared baselines**: `extends` in `.opencastle/config.json` names npm packages (devDependencies, found in `node_modules`) or relative paths; layers merge OpenCastle → baselines → project | One standard across every repository. The package manager fetches and pins it, and an upgrade bot rolls it out one pull request per repository |
| Team content in `.opencastle/` and in each baseline — `instructions/`, `agents/`, `skills/<name>/SKILL.md`, `prompts/`, `workflows/` — compiled into all seven targets | A skill or rule written once reaches every assistant, with no per-assistant copy |
| Team MCP servers written in each target's variable syntax; retired ones removed | `${NAME}` written once; Cursor, Windsurf, OpenCode and VS Code each receive a spelling they expand |
| **Policy** that only tightens: `mcp.allow`, `mcp.remoteHosts`, `mcp.requirePinned`, `require`, `contextBudget`, and the `opencastle` version range | A baseline's rules hold in every repository that extends it. A team server refused by its own layer's rules or those below is a compile error; one a higher layer refuses, and an integration server the policy refuses, is left out |
| Credentials written inline refused in team config, and failed in every MCP config `doctor` reads | A token in a committed file fails the check instead of shipping |
| `.opencastle/lock.json`, written by `sync` and compared by `sync --check` | One deterministic, reviewable record of what every assistant is given; CODEOWNERS on it routes every such change to owners |
| **Review the meaning**: `opencastle review`, on the job summary in CI | Reviewers read "New MCP server acme-flags from this project" or "@acme/opencastle-baseline's MCP allowlist now also allows Sentry", marked ⚠️ where it matters — not a hundred lines of generated Markdown |
| **Instruction health** in `doctor`: always-loaded context against the budget with the largest contributors, dead `npm run` scripts and repository paths in team content, CLI version skew | Rot and bloat show up before an agent follows a stale instruction |
| **Onboarding**: `opencastle explain` | A new teammate sees what their assistant gets, where each piece comes from, and which variables and sign-ins they still need |
| **CI setup**: `opencastle ci [--owners <team>]` | The drift and policy check, the review summary and CODEOWNERS lines in one command |
| `opencastle baseline init` and `check` | A baseline package scaffolded with its CI check, and validated the way every repository extending it will read it — including that `npm publish` ships the layer |
| **Fleet**: `opencastle fleet <dir...>` | Which repositories run which OpenCastle and baseline versions, and which MCP servers run differently, from committed locks alone |
| `sync` refuses to downgrade a project a newer release compiled | Two teammates on different versions no longer rewrite each other's output |
| **Namespaced commands**: `/oc:bug-fix` in Claude Code (`.claude/commands/oc/`) and Copilot (`.github/prompts/oc.*.prompt.md`), a team's own prompts included; `sync` removes the un-namespaced files an earlier release wrote | A teammate's own `/bug-fix` keeps working beside ours, and `sync`, `sync --check` and `remove` never touch a command OpenCastle did not write |
| Integration servers' variables written as `${env:NAME}` for Cursor and Windsurf and `{env:NAME}` for OpenCode | Cursor and OpenCode passed the `${NAME}` written before to the server as literal text |
| **Codex CLI** receives skills in `.agents/skills/` and MCP servers as `[mcp_servers.<name>]` tables in `.codex/config.toml`, changed table by table so the rest of the file stays the user's; variables as `env_vars`, `bearer_token_env_var` and `env_http_headers`. `sync` removes `.codex/skills/` and takes our servers out of `.codex/mcp.json` | Codex reads neither of the paths written before, so a Codex user got AGENTS.md and no skill, integration or team server at all |
| **Lessons as files**: `opencastle lesson` writes `.opencastle/lessons/<date>-<title>.md`; `LESSONS-LEARNED.md` becomes an index compiled from them by `sync` and checked by `sync --check`. A lesson can `--cite` code; `doctor` names one whose cited file changed since it was verified (`lesson verify`, `lesson archive`). A credential in a lesson is refused. `sync` moves an old single-file log into files and keeps a backup | Every lesson was appended to one file and numbered one past the highest there, so two branches each adding one conflicted and both called theirs LES-042. And nothing said when a lesson's code had moved on |
| **Agent Plugins 1.0**: a baseline can be an Agent Plugin — `plugin.json`, `skills/`, `mcp.json`, and OpenCastle's own content and policy in the `dev.opencastle/` extension directory — and `baseline init` creates one. `extends` takes any Agent Plugin, from npm or a path, with no OpenCastle declaration; its portable servers become team servers held to the policy | One package is the team's standard twice over: Copilot, VS Code, Cursor, Codex and Kiro install it natively, and OpenCastle compiles it — with what the standard does not cover — into all seven assistants. A team adopting an Agent Plugin someone else publishes gets it in every assistant, not only the ones that read plugins |
| **`opencastle plugin`**: `check` loads a plugin as a conformant client must (closed manifest, Agent Skills names, MCP server variants, containment); `build` writes Claude Code's `.claude-plugin/plugin.json` and `.mcp.json` from the portable files; `index` writes the marketplace files Claude Code and Copilot CLI, Cursor and Codex read | The standard leaves Claude Code's manifest and each marketplace format to the client, which is three copies of one fact kept by hand — compiled and checked instead, like everything else |
| Each integration is an Agent Plugin directory, checked against the spec in CI, and its skill compiles under the skill's own name (`supabase-database/`, not `supabase/`) | An assistant that follows the Agent Skills spec skips a skill whose name does not match its directory — every integration skill was one. An `exclude` naming the old directory still works, with a warning |

## Next, in order of leverage

### 1. Team servers that reach Windsurf

OpenCastle writes `.windsurf/mcp.json` for Windsurf, whose MCP config is
documented as one global file in the user's home directory. Until it is
compiled to where Windsurf reads it — or `explain` says what to add to the
global file — a team server may not reach Windsurf at all. (Codex, the other
assistant this used to name, now gets `.codex/config.toml`.)

### 2. VS Code without a prompt per variable

A team server's `env` entry that only forwards a variable becomes VS Code's
`envFile`; any other reference — a header, an argument — becomes a password
input VS Code asks for once. If VS Code's `mcp.json` expands `${env:NAME}` in
those fields, writing that instead would remove the prompts. Unverified.

### 3. Pinning the whole dependency tree

A pinned `npx` server pins the server's own version, not its dependency tree:
npx resolves that per machine with no lockfile. A stricter policy — servers
installed as the project's devDependencies and launched with `npx --no`, or
remote — would close the gap, and `requirePinned` is the natural place to
offer it.

### 4. CI beyond GitHub Actions

`opencastle ci` writes a GitHub Actions workflow, and the annotations and job
summary are GitHub's. `sync --check` and `review --markdown` run anywhere, but a
GitLab CI template — and posting the review as a merge request or pull request
comment rather than only a job summary — is still to do.

### 5. A hosted fleet view

`fleet` reads repositories you have checked out. An organisation-wide view
would read each repository's committed lock through the forge's API, without
cloning, and answer "who is behind on the baseline" continuously.

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

Agent Plugins, Codex's `.agents/skills/` and integration skill names are done
(see Shipped). What remains: write each skill once, to `.agents/skills/`, for
every assistant that reads it there — Cursor and VS Code read it besides their
own directories, so today a project targeting several assistants gives some of
them the same skill twice. Keep per-assistant dialects only where an assistant
needs one. Fewer generated files means less to review and less to drift — and
the lock already records what each assistant is given, so the reduction can be
reviewed like any other change.

## Open questions to verify

- Windsurf's MCP config is documented as a global file. Whether the
  `${env:NAME}` written into a team server's headers is honoured there — and
  whether a project-level `.windsurf/mcp.json` is read at all — needs checking
  against the current release.
- Antigravity receives `${NAME}` for team and integration servers alike; its
  variable syntax has not been confirmed. Codex's has: it expands none, and
  reads variables only through `env_vars`, `bearer_token_env_var` and
  `env_http_headers`, which is what it now gets. A reference in any other shape
  — part of an argument, or a header that is not wholly one variable — still
  reaches a Codex server as text, and `doctor` says so.
- Codex loads a project's `.codex/config.toml` only in a project the user has
  marked as trusted. `explain` does not say so yet.
- How each assistant treats an unset variable in its own syntax — an empty
  string, the literal text, or a server that fails to start — and whether Claude
  Code's `${VAR:-default}` is the safer spelling there.
- Always-loaded context is one estimate — four characters per token, over the
  merged instructions and the skill and agent index — not a count per
  assistant. What each target loads differs: Copilot scopes instructions with
  `applyTo`, and each assistant builds its own index. Whether a per-target
  number is worth the complexity is open.
- Retiring a team server relies on the committed lock naming it. A developer
  whose MCP config is kept out of git, and who pulls a lock that has already
  dropped the server, keeps it until they remove it by hand.
- `explain` counts a variable as set when it is in the shell or in `.env` at
  the project root. A VS Code user whose server reads it from a password input
  is reported as missing it.
- `previousMcpConfigs` records the defaults this tool's plugin files have held
  since the plugins moved to their current layout. Entries from older releases
  in a different shape are treated as edited: `doctor` says so and names the
  remedy (delete the entry and `sync --force`), but they are not moved
  automatically.
- `doctor` and `sync --check` decide which plugin servers a project includes
  from the repository facts recorded at the last `init` or `sync`; `sync`
  re-detects them. If a deployment or monorepo file appears in between, the two
  can briefly disagree about a server until the next sync records the change.
- Figma's remote server lists the clients it supports; OpenCode, Windsurf and
  Antigravity are not on that list. Those targets may need Figma's desktop
  server (`http://127.0.0.1:3845/mcp`) instead, which needs a per-target config.
- The Windsurf and Antigravity MCP outputs should be checked against each
  vendor's current documentation, the way the Claude Code and Codex shapes
  were: remote servers may need a different key there.

## How we will know it works

- Share of an organisation's repositories whose `sync --check` is green on the
  default branch.
- Time from a baseline release to every repository synced — `opencastle fleet`
  shows who is behind.
- Distinct versions of each MCP server running across repositories — the target
  is one, and `fleet` lists every server that runs differently.
- `doctor` findings per repository, trending to zero.
