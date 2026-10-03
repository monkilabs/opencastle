# Contributing to OpenCastle

Welcome! We're glad you're interested in contributing to OpenCastle. Whether it's a bug report, feature idea, documentation improvement, or code contribution — every bit helps.

## Code of Conduct

By participating in this project you agree to treat everyone with respect and follow our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, be constructive.

## Reporting Bugs

Found a bug? Please [open an issue](https://github.com/monkilabs/opencastle/issues/new/choose) with:

- A clear, descriptive title
- Steps to reproduce the problem
- Expected vs. actual behavior
- Your Node.js version and OS
- Any relevant logs or screenshots

## Suggesting Features

Have an idea? [Open a feature request](https://github.com/monkilabs/opencastle/issues/new/choose) and describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Development Setup

### Prerequisites

- **Node.js** >= 22.5 (the CLI uses `node:sqlite`)
- **npm**

### Getting Started

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/opencastle.git
cd opencastle

# 2. Install dependencies
npm install

# 3. Build the CLI — bin/cli.mjs loads from dist/, and some tests drive it
npm run cli:build

# 4. Run tests
npm test

# 5. Try the CLI on a scratch project
mkdir -p /tmp/oc-try && cd /tmp/oc-try && git init -q
node <your-clone>/bin/cli.mjs init --yes && node <your-clone>/bin/cli.mjs sync --check
```

Run the CLI from your clone as `node <your-clone>/bin/cli.mjs`, in a scratch
project rather than in the repository itself.

### The dashboard

The convoy run viewer in `src/dashboard/` is built from a demo database, the
way the website deploy builds it:

```bash
npm run dashboard:generate-demo-db && npm run dashboard:etl && npm run dashboard:build
```

`npm run dashboard:preview` serves the result on port 4300. A project's own
runs are viewed with `opencastle convoy dashboard`.

## Pull Request Process

### Branch Naming

Create a branch from `main` using this convention:

- `feat/your-feature` — for new features
- `fix/your-fix` — for bug fixes
- `docs/your-change` — for documentation updates
- `chore/your-change` — for maintenance tasks

### Before Submitting

1. **Keep PRs focused** — one concern per pull request.
2. **Write tests** for any new functionality.
3. **Run what CI runs, in its order.** After `npm ci`, CI runs:
   ```bash
   npx tsc --noEmit && npm run cli:build && npm test && npm run verify:claims
   ```
   The build comes before the tests: `bin/cli.mjs` loads from `dist/`, and
   without it the tests that drive the CLI skip or fail. Between `npm test` and
   `verify:claims`, CI also runs two scripted checks on scratch projects — a
   compile-and-check round trip and an upgrade from a pre-0.36 install — written
   out in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
4. **Write a clear PR description** — explain what changed and why.

### Review Expectations

- A maintainer will review your PR, usually within a few days.
- You may be asked to make changes — this is normal and collaborative.
- Once approved, a maintainer will merge your PR.

## Coding Standards

- **TypeScript** — all code must be written in TypeScript with proper types.
- **No `any`** — avoid `as any` or untyped code. Use precise types.
- **Tests required** — new features and bug fixes should include tests (Vitest).
- **Clean code** — prioritize readability and simplicity over cleverness.
- **Self-documenting** — use descriptive names; comment *why*, not *what*.

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `bin/` | CLI entry point; loads `dist/`, so build before running it |
| `src/cli/` | CLI commands and adapters |
| `src/orchestrator/` | Agent definitions, workflows, skills and integrations |
| `src/dashboard/` | Convoy run viewer (Astro) |
| `website/` | Project website and docs |
| `docs/` | Quickstart and the teams design notes |
| `scripts/` | Repository tooling: claim verification, MCP pin checks, plugin packing |

## Getting Help

- **Questions?** Start a thread in [GitHub Discussions](https://github.com/monkilabs/opencastle/discussions).
- **Stuck on a PR?** Leave a comment — we're happy to help.

---

Thank you for helping make OpenCastle better! 🏰
