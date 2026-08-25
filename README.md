# OpenCastle

<p align="center">
  <img src="opencastle-logo.png" alt="OpenCastle" width="480" />
</p>

<p align="center">
  <strong>Write your AI assistant config once. Use it in every assistant.</strong>
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
opencastle doctor       # diagnose setup problems
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

Commit the generated config, like a lockfile. That is what gives the check
something to compare and what lets a teammate clone the repo and have working
rules without running anything. Only `.env` and run artefacts are gitignored.

Upgrading from 0.35 or earlier? Run `opencastle sync` once — it rewrites the
`.gitignore` block, repairs the manifest, and adopts root files an older release
generated, keeping a `.opencastle-backup` of each. See
[the quickstart](docs/quickstart.md#upgrading-from-035-or-earlier).

<br>

## Supported assistants

| Assistant | Compiles to |
|-----------|-------------|
| **Claude Code** | `CLAUDE.md` + `.claude/` |
| **GitHub Copilot** | `.github/` — agents, skills, prompts |
| **Cursor** | `.cursorrules` + `.cursor/rules/*.mdc` |
| **Windsurf** | `.windsurfrules` + `.windsurf/rules/*.md` |
| **OpenCode** | `AGENTS.md` + `.opencode/` + `opencode.json` |
| **Codex CLI** | `AGENTS.md` + `.codex/` |
| **Antigravity** | `GEMINI.md` + `.agents/` |

Each target gets that assistant's native format, including its own frontmatter
dialect for how a rule is scoped. MCP servers are configured per assistant too,
in whichever shape it expects.

<br>

## What gets compiled

**Agents** — 13 role definitions (Developer, UI/UX, Data, Security, Testing,
Reviewer, and others), each with a defined scope and output contract.

**Skills** — 27 domain skills plus 31 tool integrations, loaded on demand so
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
