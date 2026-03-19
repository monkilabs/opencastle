# Contributing to OpenCastle

Welcome! We're glad you're interested in contributing to OpenCastle. Whether it's a bug report, feature idea, documentation improvement, or code contribution — every bit helps.

## Code of Conduct

By participating in this project you agree to treat everyone with respect and follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be kind, be constructive.

## Reporting Bugs

Found a bug? Please [open an issue](https://github.com/monkilabs/opencastle/issues/new) with:

- A clear, descriptive title
- Steps to reproduce the problem
- Expected vs. actual behavior
- Your Node.js version and OS
- Any relevant logs or screenshots

## Suggesting Features

Have an idea? [Open a feature request](https://github.com/monkilabs/opencastle/issues/new) and describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Development Setup

### Prerequisites

- **Node.js** >= 18
- **npm**

### Getting Started

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/opencastle.git
cd opencastle

# 2. Install dependencies
npm install

# 3. Build the project
npm run cli:build

# 4. Run tests
npm test

# 5. Try the CLI locally
npx opencastle doctor
```

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
3. **Run the full suite** — make sure `npm test` passes.
4. **Build cleanly** — confirm `npm run cli:build` succeeds with no errors.
5. **Write a clear PR description** — explain what changed and why.

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
| `src/cli/` | CLI commands and adapters |
| `src/orchestrator/` | Agent definitions, workflows, and skills |
| `src/dashboard/` | Observability dashboard (Astro) |
| `website/` | Project website |

## Getting Help

- **Questions?** Start a thread in [GitHub Discussions](https://github.com/monkilabs/opencastle/discussions).
- **Stuck on a PR?** Leave a comment — we're happy to help.

---

Thank you for helping make OpenCastle better! 🏰
