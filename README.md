# OpenCastle

<p align="center">
  <img src="opencastle-logo.png" alt="OpenCastle" width="480" />
</p>

<p align="center">
  <strong>Write your AI config once. Every assistant. Every teammate.</strong>
</p>

<p align="center">
  <a href="https://github.com/monkilabs/opencastle/stargazers"><img src="https://img.shields.io/github/stars/monkilabs/opencastle?style=flat" alt="GitHub stars" /></a>
  <a href="https://www.npmjs.com/package/opencastle"><img src="https://img.shields.io/npm/v/opencastle.svg?v=1" alt="npm version" /></a>
  <a href="https://github.com/monkilabs/opencastle/actions/workflows/ci.yml"><img src="https://github.com/monkilabs/opencastle/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/opencastle"><img src="https://img.shields.io/npm/dm/opencastle.svg?v=1" alt="downloads" /></a>
</p>

<p align="center">
  <a href="https://www.opencastle.dev/">Website</a> &middot;
  <a href="docs/quickstart.md">Quickstart</a> &middot;
  <a href="https://www.opencastle.dev/docs/">Docs</a> &middot;
  <a href="ARCHITECTURE.md">Architecture</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

Your team's AI assistant config is scattered across seven formats. Someone wrote
`CLAUDE.md`. Someone else keeps `.cursor/rules/`. Copilot reads
`.github/copilot-instructions.md`. They say almost the same thing, and they
drift apart the moment anyone edits one of them.

OpenCastle compiles one source into all of them, and tells you when they fall
out of sync.

<br>

## Quick Start

```bash
npx opencastle init
```

It reads your repository first: which assistants you already have config for,
which framework and database you use, which test runner. Then it shows you what
it found and asks once.

```
  🏰 OpenCastle

  Found assistant config:
    • Claude Code (CLAUDE.md)

  Will compile for:
    → Claude Code

  Integrations detected:
    nextjs, supabase, vitest, chrome-devtools

  Set this up? [Y/n]
```

No questionnaire. Your existing files are never overwritten — OpenCastle tells
you which ones it left alone.

Full walkthrough: **[docs/quickstart.md](docs/quickstart.md)** — five minutes.

<br>

## Everyday use

```bash
opencastle              # what's installed, what drifted, what to run next
opencastle sync         # recompile every target from source
opencastle sync --check # fail if anything drifted (for CI)
opencastle add stripe   # adopt a new tool, recompile
opencastle doctor       # diagnose setup problems, audit MCP servers
```

Running `opencastle` with no arguments is the one command worth remembering. It
answers the question you actually have:

```
  🏰 OpenCastle

  ! 2/3 targets in sync (sources are newer)
    ✓ claude-code    up to date
    ✓ cursor         up to date
    ! vscode         4 paths missing

  Next: opencastle sync
  generated files are older than the framework sources
```


### Keep it in sync in CI

`sync --check` compiles to a scratch directory and compares. It writes nothing and
exits non-zero when a generated file no longer matches its source — someone edited
`.cursor/rules/foo.mdc` by hand, added a file under a generated directory, or
upgraded without recompiling.

```yaml
# .github/workflows/opencastle.yml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx opencastle sync --check
```

`opencastle ci` writes the whole workflow for you: it installs dependencies so
baselines resolve, runs the project's own OpenCastle version, and adds `review`
on pull requests.

Commit the generated config, like a lockfile. That is what gives the check
something to compare and what lets a teammate clone the repo and have working
rules without running anything. Only `.env` and run artefacts are gitignored.

Upgrading from 0.35 or earlier? Run `opencastle sync` once — it rewrites the
`.gitignore` block, repairs the manifest, and adopts root files an older release
generated, keeping a `.opencastle-backup` of each. See
[the quickstart](docs/quickstart.md#upgrading-from-035-or-earlier).

<br>

## Built for teams

Everyone keeps the assistant they like. The team keeps one reviewed source, and
can share it across every repository it owns.

```jsonc
// .opencastle/config.json
{
  "$schema": "https://www.opencastle.dev/schema/config.json",
  "extends": ["@acme/opencastle-baseline"],  // a devDependency; your lockfile pins it
  "exclude": ["skills/seo-patterns"],
  "mcpServers": {
    "acme-db": {
      "command": "npx",
      "args": ["-y", "@acme/db-mcp@2.2.0"],
      "env": { "ACME_DB_URL": "${ACME_DB_URL}" }  // each assistant gets its own spelling
    }
  }
}
```

- **One standard, many repositories.** A baseline is an ordinary npm package
  carrying the organisation's instructions, skills, agents, MCP servers and
  policy — and, as `baseline init` lays it out, an Agent Plugin. Each repository installs it as a devDependency and names it in
  `extends`; the lockfile pins the version, and an upgrade bot opens one pull
  request per repository when it moves. What a repository adds under
  `.opencastle/` — `instructions/`, `skills/<name>/SKILL.md`, `agents/` —
  compiles into all seven assistants the same way.
- **Policy only tightens.** A baseline can say which MCP servers may run, which
  hosts remote ones may reach, that every server is pinned to an exact version,
  which items no repository may drop, and how much context may load before a
  task. A repository can tighten it, never relax it, and can opt out of a
  baseline's server. A server that breaks its own layer's policy, or a
  credential written inline, is a compile error, and `doctor` and
  `sync --check` hold servers someone added to an MCP config by hand to the same
  policy.
- **Team memory that merges and keeps current.** Agents record lessons with
  `opencastle lesson`, one file each in `.opencastle/lessons/`, citing the code
  a lesson is about; `doctor` names a lesson whose code has changed since.
  `opencastle promote` makes what one person's assistant learned the team's: a
  personal skill into the team's sources or a baseline, and Claude Code's auto
  memory for the repository into lessons — in the working tree, for the pull
  request to review.
- **A lock you can review.** `sync` writes `.opencastle/lock.json`: which layers
  at which versions, where every skill and instruction came from, which MCP
  servers every assistant can start, and how many tokens load up front.
  `opencastle review` puts the change to it into sentences on the pull request,
  and marks with ⚠️ what deserves a careful look — a new MCP server, a widened
  allowlist, a new always-loaded instruction.
- **Drift shows up on the pull request.** On GitHub Actions, `sync --check`
  annotates each drifted file with that file's own fix and writes a table to the
  run's summary page. Nothing to configure: it reads `GITHUB_ACTIONS`.
- **MCP servers are pinned like dependencies.** Every server OpenCastle adds is
  the vendor's own remote server, the project's own copy of a tool it already
  uses (`npx --no`), or a package at an exact version — never `@latest`. Every
  laptop and every CI run starts the same server version. (A pin fixes the
  server's own version, not the versions of its dependencies, which npx resolves
  per machine.) Upgrading OpenCastle moves them forward in one reviewable diff,
  and an entry you edited is left alone.
- **`doctor` audits what your agents launch**, including servers you added
  yourself: a package with no exact version, one that no longer exists on npm,
  a remote server your assistant cannot load, a credential written into the
  file, or a server the policy does not allow. It also checks the team's own
  sources: that they resolve, how much context every assistant loads against
  the budget, and whether instructions still name scripts and paths that exist.
  Each finding names the fix that works for it.
- **Built on the open standards.** Codex and OpenCode read `AGENTS.md`; every
  skill is a `SKILL.md` folder named as the skill, in the Agent Skills format,
  wherever each assistant reads skills; every assistant gets its MCP servers in
  its own config. And [Agent Plugins 1.0](https://agent-plugins.org) packages
  them: a baseline is one, so Copilot, VS Code, Cursor, Codex and Kiro can
  install it as it is, while OpenCastle compiles it — and what the standard
  does not cover yet — into all seven assistants. Any Agent Plugin on npm can be
  extended the same way. `opencastle plugin` checks one against the spec,
  writes the manifest Claude Code reads instead, and writes the marketplace file
  for Claude Code, Copilot, Cursor and Codex. Each of the integrations ships as
  an Agent Plugin too.

```bash
opencastle explain                     # what a new teammate's assistant gets, and what to set up
opencastle ci --owners @acme/platform  # CI check and review on every PR; owners for the lock
opencastle baseline init               # start the organisation's baseline package (an Agent Plugin)
opencastle plugin check                # check it the way every assistant loads it
opencastle promote memory              # what your assistant learned here, as lessons for the team
opencastle fleet ~/src/*               # which repositories run which baseline version
```

The guide — layers, every config field, policy, the lock, a rollout recipe:
**[opencastle.dev/docs/teams](https://www.opencastle.dev/docs/teams/)**. What is
still open: **[docs/teams.md](docs/teams.md)**.

<br>

## Supported assistants

| Assistant | Compiles to |
|-----------|-------------|
| **Claude Code** | `CLAUDE.md` + `.claude/` — commands as `/oc:<name>` |
| **GitHub Copilot** | `.github/` — agents, skills, prompts as `/oc:<name>` |
| **Cursor** | `.cursorrules` + `.cursor/rules/*.mdc` + `.agents/skills/` |
| **Windsurf** (Devin Desktop) | `.windsurfrules` + `.windsurf/rules/*.md` + `.agents/skills/` + `.devin/mcp_config.json` |
| **OpenCode** | `AGENTS.md` + `.agents/skills/` + `.opencode/` + `opencode.json` |
| **Codex CLI** | `AGENTS.md` + `.agents/skills/` + `.codex/` (MCP in `config.toml`) |
| **Antigravity** | `GEMINI.md` + `.agents/` (skills in `.agents/skills/`) |

Each target gets that assistant's native format, including its own frontmatter
dialect for how a rule is scoped. MCP servers are configured per assistant too,
in whichever shape it expects.

Compiled commands share one namespace — `/oc:bug-fix`, `/oc:implement-feature`,
and a team's own prompts as `/oc:<name>` — so a command of yours with the same
name keeps working beside them. In `.claude/commands/` and `.github/prompts/`,
OpenCastle writes only its `oc` files and leaves everything else alone.

<br>

## What gets compiled

**Agents** — 13 role definitions (Developer, UI/UX, Data, Security, Testing,
Reviewer, and others), each with a defined scope and output contract.

**Skills** — 31 domain skills plus 31 tool integrations, loaded on demand so
they don't sit in the context window. Selected during init from what your
repository actually uses.

**Workflows** — 9 templates for recurring work: features, bug fixes, data
pipelines, security audits, migrations.

**Quality gates** — a review pass after each step, panel review for high-stakes
changes, plus your own lint, test, and build commands.

Agents declare a capability *tier* — premium, standard, or economy — rather than
a model name. Your assistant picks the model: it knows which ones your account
can reach and what they cost today. A pinned model name can only be wrong later.

<br>

## Convoy Engine (experimental)

For work too long to sit and watch, the convoy engine runs tasks in dependency
order across isolated git worktrees, with SQLite persistence so a crash resumes
instead of restarting.

```bash
opencastle convoy "Add user reviews to the place detail page"
opencastle convoy                    # where did the last run get to?
opencastle convoy resume             # continue after an interruption
```

It plans the work, executes it, and runs your gates. Inspired by Steve Yegge's
[Gas Town](https://github.com/steveyegge/gastown).

This part is experimental and may change. The compiler above does not depend on
it.

<br>

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for how the adapters, skill matrix,
and convoy engine fit together.

<br>

## Contributing

1. Fork the repo
2. Create a branch — `feat/your-feature` or `fix/your-fix`
3. Make changes and ensure `npm test` and `npx tsc --noEmit` pass
4. Open a PR

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

<br>

## License

MIT — see [LICENSE](LICENSE).
