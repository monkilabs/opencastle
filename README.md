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
  …
  Found assistant config:
    • Claude Code (CLAUDE.md)

  Will compile for:
    → Claude Code

  Integrations detected:
    nextjs, supabase, vitest, chrome-devtools

  Set this up? [Y/n]
  …
  ✓ Created 114 files
  ✓ Created .gitignore with OpenCastle entries
  ✓ Merged into your existing CLAUDE.md
    your content is above the managed block and is never overwritten
  …
```

What you wrote in `CLAUDE.md`, `.cursorrules`, `AGENTS.md` and the other root
files stays above a managed block. A file of yours inside a directory OpenCastle
generates (`.cursor/rules/`, `.claude/agents/`, …) is named by `init` and
removed by the next `sync`; move it into `.opencastle/` and it compiles for
every assistant.

Node.js 22.5 or newer. Full walkthrough, including CI and upgrading:
**[docs/quickstart.md](docs/quickstart.md)**.

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
  🏰 OpenCastle v1.0.0

  ! 2/3 targets installed — generated files no longer match their sources
    ✓ claude-code    up to date
    ✓ cursor         up to date
    ! vscode         4 paths missing

  Next: opencastle sync
  1 target missing generated files
```

Commit the generated config, like a lockfile, and let CI check it:
`npm i -D opencastle && npx opencastle ci` writes a GitHub Actions workflow that
runs `sync --check` on every pull request
([quickstart, step 4](docs/quickstart.md#4-keep-it-honest-in-ci)). Every command
and flag: [opencastle.dev/docs/cli](https://www.opencastle.dev/docs/cli/).

Upgrading from 0.35 or earlier? Run `opencastle sync` once — see
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
    "acme-db": {  // must be on the baseline's policy.mcp.allow
      "command": "npx",
      "args": ["-y", "@acme/db-mcp@2.2.0"],
      "env": { "ACME_DB_URL": "${ACME_DB_URL}" }  // each assistant gets its own spelling
    }
  }
}
```

`extends` takes npm packages, found in `node_modules`, or relative paths, which
resolve from `.opencastle/` — a `baseline/` directory at the project root is
`"../baseline"`.

- **One standard, many repositories.** A baseline is an npm package with the
  organisation's instructions, skills, agents, MCP servers and policy. As
  `baseline init` lays it out, it is also an [Agent Plugin](https://agent-plugins.org),
  so Copilot, VS Code, Cursor, Codex and Kiro can install it as it is. What a
  repository adds under `.opencastle/` compiles into all seven assistants.
- **Policy only tightens.** A baseline says which MCP servers may run, which
  hosts remote ones may reach, that every server is pinned, which items no
  repository may drop, and how much context may load before a task. A
  repository can tighten it, never relax it.
- **A lock you can review.** `sync` writes `.opencastle/lock.json`.
  `opencastle review` turns a change to it into sentences on the pull request
  and marks with ⚠️ what deserves a careful look, such as a new MCP server.
- **MCP servers pinned and audited.** Every server OpenCastle adds is the
  vendor's remote server, the project's own copy of a tool (`npx --no`), or a
  package at an exact version. `doctor` and `sync --check` audit every MCP
  config, including servers you added by hand: no exact version, a package
  OpenCastle knows is not on npm, a credential written into the file, a server
  the policy does not allow.
- **Team memory.** Agents record lessons with `opencastle lesson`, one file each
  in `.opencastle/lessons/`, citing the code they are about; `doctor` names a
  lesson whose code has changed. `opencastle promote` turns a personal skill or
  Claude Code's auto memory into the team's, for the pull request to review.

```bash
opencastle explain                     # what a new teammate's assistant gets, and what to set up
opencastle ci --owners @acme/platform  # CI check and review on every PR; owners for the lock
opencastle baseline init acme-baseline --name @acme/opencastle-baseline  # the organisation's baseline
opencastle plugin check acme-baseline  # check it the way every assistant loads it
opencastle promote memory              # what your assistant learned here, as lessons for the team
opencastle fleet ~/src/*               # which repositories run which baseline version
```

The guide — layers, every config field, policy, the lock, a rollout recipe:
**[opencastle.dev/docs/teams](https://www.opencastle.dev/docs/teams/)**. What is
still open, and why things are the way they are: **[docs/teams.md](docs/teams.md)**.

<br>

## Supported assistants

| Assistant | Instructions | Skills | MCP config |
|-----------|--------------|--------|------------|
| **Claude Code** | `CLAUDE.md`, `.claude/agents/`, commands in `.claude/commands/oc/` | `.claude/skills/` | `.mcp.json` |
| **VS Code** (GitHub Copilot) | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/agents/`, prompts `.github/prompts/oc.*.prompt.md` | `.github/skills/` | `.vscode/mcp.json` |
| **Cursor** | `.cursorrules`, `.cursor/rules/*.mdc` | `.agents/skills/` | `.cursor/mcp.json` |
| **Windsurf** (Devin Desktop) | `.windsurfrules`, `.windsurf/rules/*.md` | `.agents/skills/` | `.devin/mcp_config.json` |
| **OpenCode** | `AGENTS.md`, `.opencode/` | `.agents/skills/` | `opencode.json` |
| **Codex CLI** | `AGENTS.md`, `.codex/` | `.agents/skills/` | `.codex/config.toml` (trusted projects only) |
| **Antigravity** | `GEMINI.md` (points to `AGENTS.md` when Codex or OpenCode is also selected), `.agents/` | `.agents/skills/` | `.agents/mcp_config.json` |

Each target gets that assistant's native format, including its own frontmatter
dialect for how a rule is scoped, and its MCP servers in the shape it expects.
`opencastle explain` lists the paths for the assistants a project compiles for.

In Claude Code and in VS Code's Copilot Chat, OpenCastle's prompts are slash
commands in one namespace — `/oc:bug-fix`, `/oc:implement-feature`, and a
team's own prompts as `/oc:<name>` — so a command of yours with the same name
keeps working beside them. In `.claude/commands/` and `.github/prompts/`,
OpenCastle writes only its `oc` files and leaves everything else alone. The
other assistants get the prompts as files (`.cursor/rules/prompts/`,
`.windsurf/rules/prompts/`, `.opencode/prompts/`, `.codex/prompts/`,
`.agents/prompts/`) that you ask for by name.

<br>

## What gets compiled

**Agents** — 13 role definitions (Developer, UI/UX, Data, Security, Testing,
Reviewer, and others), each with a defined scope and output contract. A project
gets the ones its stack needs: Content Engineer comes with a CMS, Data Engineer
with a database.

**Skills** — 31 domain skills plus 31 tool integrations, loaded on demand so
they don't sit in the context window. Selected during init from what your
repository actually uses.

**Workflows** — 8 templates for recurring work (features, bug fixes, data
pipelines, security audits, migrations, and more), plus a shared delivery
phase that ends each of them.

**Prompts** — 7 for people (brainstorm, implement-feature, bug-fix,
quick-refinement, resolve-pr-comments, bootstrap-customizations, create-skill)
and 7 steps the convoy planner runs.

**Quality gates** — a review pass after each step, panel review for high-stakes
changes, plus your own lint, test, and build commands.

Agents declare a capability *tier* — premium, standard, or economy — rather than
a model name. Your assistant picks the model: it knows which ones your account
can reach and what they cost today. A pinned model name can only be wrong later.

<br>

## Convoy Engine (experimental)

For work too long to sit and watch, the convoy engine runs tasks in dependency
order across isolated git worktrees, with SQLite persistence so a crash resumes
instead of restarting. This part is experimental and may change; the compiler
above does not depend on it.

```bash
opencastle convoy "Add user reviews to the place detail page"   # plan, show, ask, run
opencastle convoy                    # the last run and the one next step
opencastle convoy resume             # continue whatever is not done
opencastle convoy dashboard          # the live viewer
opencastle convoy run my.convoy.yml  # run a spec you wrote
```

It plans the work, shows you the plan, and runs independent tasks at the same
time on the runtime `opencastle init` set up — Claude Code, Codex, Cursor,
OpenCode or Copilot. The result lands on a branch of its own, and your gates run
once at the end. Inspired by Steve Yegge's
[Gas Town](https://github.com/steveyegge/gastown).

<br>

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for how the adapters, team sources,
skill matrix and convoy engine fit together.

<br>

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)**.

<br>

## License

MIT — see [LICENSE](LICENSE).
