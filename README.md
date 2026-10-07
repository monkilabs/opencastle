# OpenCastle

<p align="center">
  <img src="opencastle-logo.png" alt="OpenCastle" width="480" />
</p>

<p align="center">
  <strong>Your team's AI setup and memory, in every teammate's assistant.</strong>
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

Every AI coding assistant now remembers what it learns: the build that needs a
flag, the convention nobody wrote down, the staging API that rate-limits. It
remembers on one laptop. A new teammate's assistant starts from nothing, and the
next person to hit the same problem pays for it again.

OpenCastle makes it the team's. Instructions, skills and agents live in the
repository and compile for the assistant your company uses. What agents remember
about the project becomes a lesson when the agent stops, reviewed in the pull
request with the work, and every teammate's assistant loads it before its next
task. What they remember about you stays yours. Across repositories, the
organisation's standard is an [Agent Plugin](https://agent-plugins.org) every
repository extends.

It starts from your code: the stack with its versions, the commands, the routes
and the models, so the assistant knows the project on its first task.

<br>

## Quick Start

```bash
npx opencastle init
```

It reads the repository, shows what it found, and asks once:

```
  Found assistant config:
    • Claude Code (CLAUDE.md)

  Will compile for:
    → Claude Code

  Integrations detected:
    nextjs, supabase, vitest, chrome-devtools
  …
  ✓ Created 69 files
  ✓ Merged into your existing CLAUDE.md
    your content is above the managed block and is never overwritten
```

Then, in Claude Code or Copilot Chat, type `/oc:bootstrap-customizations` once,
so an agent fills in what the code could not say, and `/oc:implement-feature`
for your first change. Node.js 22.5 or newer. The full walkthrough, with CI and
upgrading: **[docs/quickstart.md](docs/quickstart.md)**.

<br>

## Everyday use

```bash
npx opencastle              # what is installed, what drifted, what to run next
npx opencastle sync         # recompile every target from source
npx opencastle sync --check # fail if anything drifted (for CI)
npx opencastle add stripe   # adopt an integration, recompile
npx opencastle doctor       # diagnose setup problems, audit MCP servers
```

Commit the generated config, like a lockfile. `npx opencastle ci` writes a
GitHub Actions workflow that runs `sync --check` on every pull request. Every
command and flag: [opencastle.dev/docs/cli](https://www.opencastle.dev/docs/cli/).

<br>

## Built for teams

A new teammate clones the repository, and their assistant starts where a
senior's is.

- **Shared memory, apart from personal.** Agents save what they learn as they
  always do. When an agent stops, a hook in Claude Code or VS Code turns what is
  about the project into a lesson in `.opencastle/lessons/`, and leaves what is
  about the person. Lessons go into the pull request with the work, cite the
  code they are about, and `doctor` names one whose code has changed.
- **Loaded without asking.** Claude Code, Copilot, Cursor and Windsurf load the
  team's lessons before every task on their own.
- **One standard, many repositories.** A baseline is an npm package with the
  organisation's instructions, skills, agents, MCP servers and policy, which
  every repository `extends`. It is also an [Agent Plugin](https://agent-plugins.org),
  and a lesson every repository needs graduates into its skills.
- **Policy only tightens.** Which MCP servers may run, which hosts they reach,
  exact versions, what no repository may drop, how much context loads before a
  task. A repository can tighten it, never relax it.
- **A lock you can review.** `sync` writes `.opencastle/lock.json`, and
  `npx opencastle review` says on the pull request what a change does to every
  assistant, marking with ⚠️ what deserves a careful look.

```bash
npx opencastle explain                     # what a new teammate's assistant gets, and what to set up
npx opencastle ci --owners @acme/platform  # the check and the review on every pull request
npx opencastle baseline init acme-baseline --name @acme/opencastle-baseline
npx opencastle fleet ~/src/*               # which repositories run which baseline version
```

Layers, every config field, policy, the lock and a rollout recipe:
**[opencastle.dev/docs/teams](https://www.opencastle.dev/docs/teams/)**.

<br>

## Supported assistants

| Assistant | Instructions | Skills | MCP config |
|-----------|--------------|--------|------------|
| **Claude Code** | `CLAUDE.md`, `.claude/agents/`, commands in `.claude/commands/oc/` | `.claude/skills/` | `.mcp.json` |
| **VS Code** (GitHub Copilot) | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/agents/`, prompts `.github/prompts/oc.*.prompt.md` | `.github/skills/` | `.vscode/mcp.json` |
| **Cursor** | `.cursorrules`, `.cursor/rules/*.mdc` — the instructions come from `CLAUDE.md` or `AGENTS.md` when one of those is written, since Cursor reads them too | `.agents/skills/` | `.cursor/mcp.json` |
| **Windsurf** (Devin Desktop) | `.windsurfrules`, `.windsurf/rules/*.md` | `.agents/skills/` | `.devin/mcp_config.json` |
| **OpenCode** | `AGENTS.md`, `.opencode/` | `.agents/skills/` | `opencode.json` |
| **Codex CLI** | `AGENTS.md`, `.codex/` | `.agents/skills/` | `.codex/config.toml` (trusted projects only) |
| **Antigravity** | `GEMINI.md` (points to `AGENTS.md` when Codex or OpenCode is also selected), `.agents/` | `.agents/skills/` | `.agents/mcp_config.json` |

Most teams use one of these; each gets its native format, so switching
providers keeps the setup and the memory. In Claude Code and Copilot Chat
the prompts are slash commands under `/oc:`, beside your own; the others get
them as files you ask for by name.

<br>

## What gets compiled

**Instructions** — a short set every assistant always loads, and your project's
facts, read from the code by `init`.

**Agents** — 13 role definitions (Team Lead, Developer, UI/UX, Data, Security,
Testing, Reviewer, and others), each with a scope and an output contract. Each
declares a capability *tier* — premium, standard or economy — rather than a
model name: your assistant picks the model.

**Skills** — 17 domain skills plus 31 tool integrations, loaded only when a task
needs them. The integrations are chosen during init from what your repository
uses.

**Prompts** — 7: brainstorm, implement-feature, bug-fix, resolve-pr-comments,
bootstrap-customizations and create-skill work in your session; convoy hands the
work to the convoy planner.

**Workflows** — 6 templates for recurring work that needs more than a prompt:
database migrations, CMS schema changes, data pipelines, performance,
refactoring and security audits.

<br>

## Convoy Engine (experimental)

For multi-step work you would rather not sit and watch. This part is
experimental and may change; the compiler does not depend on it.
`npx opencastle convoy "<task>"` plans the work without changing anything, shows
you the plan and asks once. Then it runs independent tasks at the same time,
each in its own git worktree, on the agent runtime `init` set up, and merges
them onto a branch of its own for you to review.

```bash
npx opencastle convoy "Add tags to notes, and reject a note without a title"
npx opencastle convoy dashboard   # the Observability dashboard, live
```

Real runs: [Use cases](https://www.opencastle.dev/docs/use-cases). How it works:
[ARCHITECTURE.md](ARCHITECTURE.md#convoy-architecture). Inspired by Steve
Yegge's [Gas Town](https://github.com/gastownhall/gastown).

<br>

## Contributing

How the adapters, team sources and convoy engine fit together:
**[ARCHITECTURE.md](ARCHITECTURE.md)**. How to contribute:
**[CONTRIBUTING.md](CONTRIBUTING.md)**.

<br>

## License

MIT — see [LICENSE](LICENSE).
