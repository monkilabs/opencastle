# OpenCastle for teams

> Design notes, written as the team features shipped (through 3 October 2026);
> kept for the decisions and the open questions. How to use them:
> [opencastle.dev/docs/teams](https://www.opencastle.dev/docs/teams/)

A single developer's assistant config is a solved problem. A team's is not.
Teams run several assistants side by side, each reads its own format, and
nobody owns the result: nobody reviews it, nobody notices when it drifts, and
nobody can say which MCP servers — code that runs with every developer's
credentials — the team's agents actually launch.

That is the gap OpenCastle should close. This document records the decisions
behind what shipped and what is still open, in order of leverage. How to use
what shipped is in [the guide](https://www.opencastle.dev/docs/teams/).

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

How to use each of these: [the guide](https://www.opencastle.dev/docs/teams/).

- **1.0.0** (1 October 2026) — Shared baselines through `extends`; the team's
  own instructions, skills, agents, prompts and workflows in `.opencastle/`,
  compiled into all seven assistants; policy that only tightens; the lock;
  `review`, `explain`, `ci`, `baseline` and `fleet`. Every default MCP server
  pinned, project-local or remote, audited by `doctor` and `sync --check`.
  Drift annotated on GitHub Actions. `sync` refuses to downgrade.
- **1.1.0** (1 October) — Compiled commands namespaced as `/oc:<name>` in
  Claude Code and Copilot.
- **1.1.1** (3 October) — Codex gets skills in `.agents/skills/` and MCP
  servers in `.codex/config.toml`.
- **1.2.0** (3 October) — Lessons as files that cite code; Agent Plugins 1.0
  (a baseline is one, `opencastle plugin`, every integration is one);
  `opencastle promote`.
- **1.3.0** (3 October) — Cursor, Windsurf and OpenCode read skills from
  `.agents/skills/`; Windsurf's MCP servers go to `.devin/mcp_config.json`;
  Antigravity gets remote servers as `serverUrl`, and a `GEMINI.md` that points
  to `AGENTS.md` when Codex or OpenCode is also selected; `explain` says
  whether Codex trusts the project.

### Decisions behind it

- **The package manager fetches baselines, not OpenCastle.** `extends` names
  devDependencies, found in `node_modules`, or relative paths, which resolve
  from `.opencastle/`. The lockfile pins the version and an upgrade bot rolls a
  new one out one pull request per repository.
- **Policy only tightens.** A team server refused by its own layer's policy or
  one below it is a compile error. One a higher layer refuses is left out: that
  is how a repository opts out of a baseline's server.
- **Review the meaning, not the output.** `review` reads the lock and says "New
  MCP server acme-flags from this project", marked ⚠️ where it matters, instead
  of a hundred lines of generated Markdown. CODEOWNERS on the lock routes every
  such change to its owners.
- **Integration servers are written in each assistant's variable syntax.**
  Cursor and OpenCode passed a `${NAME}` written for Claude Code to the server
  as literal text. Antigravity expands no variables, so an `env` entry that only
  forwards one is left out and the server inherits it.
- **One file per lesson.** In one shared file, two branches each adding a lesson
  conflicted and both numbered theirs one past the highest. A lesson can cite
  code, so `doctor` can say when that code has moved on.
- **Promotion is the step from personal to team.** Claude Code's auto memory is
  machine-local by design, and a personal skill reaches one assistant.
  `promote` writes them into the team's sources, and the pull request that
  commits them is the review.
- **A baseline is an Agent Plugin.** Copilot, VS Code, Cursor, Codex and Kiro
  install one natively; OpenCastle compiles it, with what the standard does not
  cover, into all seven assistants. The standard leaves Claude Code's manifest
  and each marketplace format to the client, so `opencastle plugin` compiles
  and checks those instead of three copies kept by hand.
- **Skills as Agent Skills, not rules.** Flattened into Cursor or Windsurf rules,
  a skill lost every non-Markdown file, could not be invoked by name, and was
  matched like a rule. An integration skill compiles under the skill's own name
  (`supabase-database/`), because a client following the spec skips a skill
  whose name does not match its directory.
- **Output goes where each assistant reads it.** Codex read neither path written
  before 1.1.1, and nothing read `.windsurf/mcp.json` before 1.3.0, so those
  users got no skill, integration or team server at all.
- **Instructions load once.** Antigravity reads `GEMINI.md` and `AGENTS.md`
  together, so with Codex or OpenCode selected it loaded every instruction and
  both indexes twice — about 5,000 tokens before each task in a stock project.

## Next, in order of leverage

### 1. Instructions loaded once per assistant

Antigravity is done (see Shipped). VS Code, Cursor and Devin Desktop also
support `AGENTS.md`; whether each reads it beside its own root file by default —
and so loads the same instructions twice when both exist — needs checking
against each one's docs before their root files get the same treatment.

### 2. VS Code's newer formats

VS Code now labels `.vscode/mcp.json` deprecated in favour of a portable
`.mcp.json` (`mcpServers`, `${VAR}`), and its Agent Host drops any server that
uses `${input:…}` and does not load prompt files. Moving Copilot's servers to
`.mcp.json` means sharing that file with Claude Code, whose entry shape differs
(the Copilot CLI reference also lists `tools` as required); and `/oc:` commands
cannot become skills as they are, since a skill name cannot hold `:` or `.`.

### 3. VS Code without a prompt per variable

A team server's `env` entry that only forwards a variable becomes VS Code's
`envFile`; any other reference — a header, an argument — becomes a password
input VS Code asks for once. If VS Code's `mcp.json` expands `${env:NAME}` in
those fields, writing that instead would remove the prompts. Unverified.

### 4. Pinning the whole dependency tree

A pinned `npx` server pins the server's own version, not its dependency tree:
npx resolves that per machine with no lockfile. A stricter policy — servers
installed as the project's devDependencies and launched with `npx --no`, or
remote — would close the gap, and `requirePinned` is the natural place to
offer it.

### 5. CI beyond GitHub Actions

`opencastle ci` writes a GitHub Actions workflow, and the annotations and job
summary are GitHub's. `sync --check` and `review --markdown` run anywhere, but a
GitLab CI template — and posting the review as a merge request or pull request
comment rather than only a job summary — is still to do.

### 6. A hosted fleet view

`fleet` reads repositories you have checked out. An organisation-wide view
would read each repository's committed lock through the forge's API, without
cloning, and answer "who is behind on the baseline" continuously.

### 7. Adoption signals without surveillance

Opt-in, team-level only, and never per person — individual metrics invite
gaming ([DX](https://getdx.com/research/measuring-ai-code-assistants-and-agents/)).
From git alone: the share of merged PRs with an AI co-author trailer, PR size
and time to merge, compared across the date a baseline change landed. Use it
beside DORA delivery metrics, not instead of them.

A caution from this codebase's own history: an earlier "intelligence suite" was
removed because it wrote ledgers nobody read. This one ships only with a
reader — the PR comment or the run summary — and only answers a question a team
lead actually asks.

### 8. Standards first

Agent Plugins, integration skill names, and one shared `.agents/skills/` for
Codex, Cursor, Windsurf, OpenCode and Antigravity are done (see Shipped). What
remains: VS Code still gets `.github/skills/` although it reads `.agents/skills/`
too, and `.github/skills/` is also where Copilot's cloud agent looks, which
needs checking first. Claude Code's copy is an open question (see skills written
to more than one directory, below). Keep per-assistant dialects only where an
assistant needs one. Fewer generated files means less to review and less to
drift, and the lock already records what each assistant is given, so the
reduction can be reviewed like any other change.

## Open questions to verify

- Devin Desktop's `.devin/mcp_config.json` reads `${env:NAME}` per the Cascade
  docs; the Devin CLI docs, which define that file, document variables only for
  OAuth fields. The legacy Cascade agent still reads only the global
  `~/.config/devin/mcp_config.json`. Devin Local also imports `.mcp.json`,
  `.cursor/mcp.json` and `opencode.json` by default, so with those targets
  selected it may list a server twice.
- Devin Desktop documents rules as `.windsurf/rules/*.md` (and `.devin/rules/`);
  whether it scans the subdirectories agents, workflows and prompts are written
  to is not documented.
- Codex and Antigravity expand no variables. Codex reads them only through
  `env_vars`, `bearer_token_env_var` and `env_http_headers`, which is what it
  gets; Antigravity has no such field, so a local server inherits its variables
  and a remote server's header that needs one can only be set in the person's
  own global config. A reference in any other shape reaches the server as text,
  and `doctor` says so. (Antigravity's is an open issue on its CLI, not a
  documented rule.)
- Skills a project writes to more than one directory: VS Code reads
  `.github/skills/`, `.claude/skills/` and `.agents/skills/` and keeps the first
  of each name; OpenCode keeps one copy unpredictably; Cursor lists both — its
  "Include Third-Party Plugins, Skills, and Other Configs" setting turns off the
  `.claude/skills/` copy. Claude Code reads only `.claude/skills/`, so a project
  targeting it and any `.agents/skills/` reader has two copies.
- Codex loads a project's `.codex/config.toml` only in a project the user has
  marked as trusted. `explain` checks Codex's own config for that and says so;
  `doctor` does not, because trust is a per-person setting and `doctor` runs in
  CI too.
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

## How we will know it works

- Share of an organisation's repositories whose `sync --check` is green on the
  default branch.
- Time from a baseline release to every repository synced — `opencastle fleet`
  shows who is behind.
- Distinct versions of each MCP server running across repositories — the target
  is one, and `fleet` lists every server that runs differently.
- `doctor` findings per repository, trending to zero.
