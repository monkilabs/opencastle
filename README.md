# OpenCastle

<p align="center">
  <img src="opencastle-logo.png" alt="OpenCastle" width="480" />
</p>

<p align="center">
  <strong>Turn your AI coding assistant into a multi-agent team.</strong>
</p>

<p align="center">
  <a href="https://github.com/monkilabs/opencastle/stargazers"><img src="https://img.shields.io/github/stars/monkilabs/opencastle?style=flat" alt="GitHub stars" /></a>
  <a href="https://www.npmjs.com/package/opencastle"><img src="https://img.shields.io/npm/v/opencastle.svg?v=1" alt="npm version" /></a>
  <a href="https://github.com/monkilabs/opencastle/actions/workflows/ci.yml"><img src="https://github.com/monkilabs/opencastle/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/opencastle"><img src="https://img.shields.io/npm/dm/opencastle.svg?v=1" alt="downloads" /></a>
</p>

<p align="center">
  <a href="https://www.opencastle.dev/">Website</a> &middot;
  <a href="https://www.opencastle.dev/docs/">Docs</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="ARCHITECTURE.md">Architecture</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

Works with **[GitHub Copilot](https://github.com/features/copilot)**, **[Cursor](https://www.cursor.com/)**, **[Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)**, **[OpenCode](https://opencode.ai/)**, **[Windsurf](https://windsurf.com/)**, **[Codex CLI](https://github.com/openai/codex)**, and **[Antigravity](https://developers.google.com/)**.

One command sets up specialized agents that decompose tasks, work in parallel, and verify each other's output — interactively through IDE chat or automated via the Convoy Engine.

Use it live in your IDE. Run it overnight with the CLI.

<br>

## Quick Start

```bash
npx opencastle init
```

<p align="center">
  <img src="opencastle-init.gif" alt="npx opencastle init" width="720" />
</p>

The CLI asks about your IDEs and stack. It installs agents, skills, and MCP servers tailored to your project.

You can select multiple IDEs and tools — the output is adapted for each one.

<br>

### What gets generated

| IDE | Output |
|-----|--------|
| **VS Code** | `.github/` — agents, skills, workflows, prompts |
| **Cursor** | `.cursorrules` + `.cursor/rules/` |
| **Claude Code** | `CLAUDE.md` + `.claude/` |
| **OpenCode** | `AGENTS.md` + `.opencode/` + `opencode.json` |
| **Windsurf** | `.windsurfrules` + `.windsurf/rules/` |
| **Codex CLI** | `AGENTS.md` + `.codex/` |
| **Antigravity** | `GEMINI.md` + `.gemini/` |

MCP servers are auto-configured for your stack in each IDE's native format.

<br>

### Project CLI

| Command | Description |
|---------|-------------|
| `opencastle init` | Set up agents in your project |
| `opencastle update` | Update framework files (keeps your customizations) |
| `opencastle eject` | Remove the dependency, keep all files |
| `opencastle destroy` | Remove ALL OpenCastle files (reverse of init) |
| `opencastle skills` | Skill refinement and failure tracking |
| `opencastle package` | Package orchestrator as a plugin for IDE marketplaces |

### Convoy CLI

| Command | Description |
|---------|-------------|
| `opencastle start` | Go from idea to convoy spec in one command (PRD → validate → convoy → validate → fix) |
| `opencastle plan` | Run a single prompt template step (generate PRD, convoy spec, or validate) |
| `opencastle validate` | Validate a convoy YAML spec file without executing it |
| `opencastle run` | Run the Convoy Engine (deterministic, crash-recoverable orchestrator) |
| `opencastle dispute` | Manage convoy dispute resolution |

### Observability CLI

| Command | Description |
|---------|-------------|
| `opencastle dashboard` | Open the observability dashboard |
| `opencastle doctor` | Validate your setup and surface issues |
| `opencastle agents` | Manage persistent agent identities |
| `opencastle baselines` | Manage visual regression baselines |
| `opencastle log` | Append a structured event to the observability log |
| `opencastle lesson` | Append a structured lesson to LESSONS-LEARNED.md |
| `opencastle artifacts` | Manage filesystem artifact storage (prune old convoy artifacts) |
| `opencastle insights` | Analyze convoy execution history and generate recommendations |

Add `--dry-run` to any command to preview what it would change without writing files.

📖 [Full CLI documentation →](https://www.opencastle.dev/docs/cli)

<br>

## What's Inside

**Specialist Agents.** Developer, UI/UX, Database, Security, Testing, Reviewer, and more.

**On-Demand Skills.** Loaded on demand to keep context windows lean. Auto-selected during init based on your stack. All 51 skills and plugins scored 100% on the [tessl Skill Evaluator](https://tessl.io/registry?q=opencastle).

**Workflow Templates.** Features, bug fixes, data pipelines, security audits — reproducible execution templates.

**Quality gates.** Fast review after every step. Panel majority vote for high-stakes changes. Lint, test, build checks.

**Cost-aware routing.** Picks the right model tier (Premium → Quality → Standard → Fast → Economy) based on task complexity.

**Self-improving.** Agents capture lessons and graduate them into permanent instructions.

**Hybrid by design.** Use OpenCastle interactively through IDE chat for hands-on development, or run automated batch jobs overnight via the Convoy Engine.

<br>

## Dashboard

```bash
npx opencastle dashboard
```

<p align="center">
  <img src="dashboard-screenshot.png" alt="OpenCastle Dashboard" width="800" />
</p>

Visualizes real agent data from your project — sessions, success rates, model usage, execution logs, and panel reviews.

Reads from the same NDJSON logs your agents already write. No setup needed.

📖 [Dashboard CLI documentation →](https://www.opencastle.dev/docs/cli#dashboard)

<br>

## Doctor

```bash
npx opencastle doctor
```

Runs multiple health checks — manifest, configs, skills, observability logs, IDE settings, MCP setup, and environment variables. Useful in CI or after upgrading.

📖 [Doctor CLI documentation →](https://www.opencastle.dev/docs/cli#doctor)

<br>
## Convoy Engine

A deterministic, crash-recoverable orchestrator inspired by Steve Yegge's [Gas Town](https://github.com/steveyegge/gastown). Define tasks in YAML, run overnight, resume after crashes.

```bash
npx opencastle run convoy.yml
```

```yaml
# convoy.yml
name: "Overnight feature batch"
version: 1
adapter: claude
branch: feat/reviews

tasks:
  - id: migrate-db
    agent: database-engineer
    prompt: "Create a reviews table migration."
    files: ["db/migrations/"]

  - id: build-component
    agent: ui-ux-expert
    prompt: "Build a ReviewCard component."
    files: ["src/components/reviews/"]

  - id: wire-page
    agent: developer
    prompt: "Add reviews to the place detail page."
    depends_on: [migrate-db, build-component]
    files: ["src/pages/places/"]

gates:
  - npm run lint
  - npm run test
```

- **Crash-safe** — SQLite WAL persistence survives crashes, power loss, OOM kills. Resume with `--resume`.
- **Isolated** — each worker runs in its own git worktree. Changes merge back in dependency order.
- **Observable** — real-time dashboard auto-starts during execution.
- **Multi-runtime** — mix Copilot, Claude Code, Cursor, OpenCode, Windsurf, Codex, and Antigravity in the same convoy.

Generate a validated convoy spec from a plain text description — no YAML by hand:

```bash
npx opencastle start --text "Add user reviews to the place detail page"
```

The start command runs 7 steps automatically: generate PRD → validate PRD → auto-fix PRD if needed → assess complexity → generate convoy spec → validate spec → auto-fix spec if needed. For lower-level control, use `opencastle plan` to run individual steps.

📖 [Full Convoy Engine documentation →](https://www.opencastle.dev/docs/cli#run)

<br>

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full diagram, workflow templates, and quality gates.

<br>

## Contributing

1. Fork the repo
2. Create a branch — `feat/your-feature` or `fix/your-fix`
3. Make changes and ensure `npm run build:cli` passes
4. Open a PR

For large changes, [open an issue](https://github.com/monkilabs/opencastle/issues) first.

<br>

## Support

OpenCastle is free and open-source.

<p align="center">
  <a href="https://ko-fi.com/A0A61V4992" target="_blank"><img height="36" style="border:0px;height:36px;" src="https://storage.ko-fi.com/cdn/kofi4.png?v=6" border="0" alt="Buy Me a Coffee at ko-fi.com" /></a>
</p>

For corporate sponsorship inquiries, open a [GitHub Discussion](https://github.com/monkilabs/opencastle/discussions).

<br>

## License

[MIT](LICENSE)
