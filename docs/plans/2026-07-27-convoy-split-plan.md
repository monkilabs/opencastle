# Convoy Split Plan — two projects, one purpose each

_Date: 2026-07-27. Status: proposal. Builds on
[2026-07-25-strategic-refactoring-plan.md](2026-07-25-strategic-refactoring-plan.md)
Phase 4a, which deferred the physical move after enforcing the dependency
direction._

## 1. Decision

Split the repository into two independent projects:

| | **OpenCastle** | **Convoy** |
|---|---|---|
| One sentence | Compiles one config source into every AI assistant's native format, and fails CI when they drift. | Runs long AI coding tasks deterministically — DAG-planned, crash-safe, in isolated worktrees — and shows live progress in your browser. |
| Repo | `monkilabs/opencastle` (stays) | new repo (name: §3) |
| Maturity promise | Stable, boring, CI-grade | Experimental, honest about it |
| Runtime deps after split | **zero** | `@github/copilot-sdk`, `valibot`, `yaml`, `node:sqlite` |

The dashboard as it exists today (Astro app + ETL + demo generator, ~7k LOC) is
**not** extracted — it is replaced by a small live viewer that ships inside
Convoy (§5). Historical stats go away; watching the current run is the product.

Ground rule carried over from the refactoring plan: each phase leaves `main`
shippable. The split is a sequence of releases, not a long-lived branch.

## 2. Why (the communicable rationale)

This section is the story both READMEs, the changelog, and any launch post tell.
Keep it consistent everywhere.

> **One project, one promise.** OpenCastle promises your assistant config
> compiles everywhere — that needs to be stable, predictable, and dependency-free,
> because it runs in your CI. Convoy promises an experiment worth watching —
> deterministic multi-agent runs with live observability — and experiments need
> to move fast and break things. Living in one package, each constrained the
> other: the compiler shipped 30k lines of engine it never called, and the
> engine's releases rode a train built for a config tool. Now the compiler is
> pure (zero runtime dependencies, ~19k LOC, 6 commands) and the runner is free.

Supporting facts, all verified on this branch:

- The compiler and engine share exactly **3 import edges over 2 symbols**
  (§4) — the split is severing string, not muscle.
- All 3 runtime npm dependencies belong to the engine. The extracted compiler
  has **zero**.
- `boundary.test.ts` already enforces the direction; the physical move is
  mechanical, as Phase 4a predicted.

## 3. How each project is communicated

### 3.1 OpenCastle (after the split)

- **Tagline (keep):** "Write your AI assistant config once. Use it in every
  assistant."
- **Category:** build system / compiler for AI-assistant configuration.
- **Audience:** teams running one or more AI coding assistants; whoever owns
  `CLAUDE.md` / `.cursor/rules` / `copilot-instructions.md`; platform & DX
  engineers who want config in CI.
- **Vocabulary:** compile, source, targets, sync, drift, lockfile. Never "agents
  run", "orchestration", or "convoy" in product copy.
- **README:** leads with the config-lift moment (the planned 30-second
  recording). The `## Convoy Engine (experimental)` section (README.md:160-183)
  is deleted and replaced by one line under a new `## Related projects` footer:
  *"Convoy — a deterministic runner for long AI coding tasks, from the same
  team. Started life inside OpenCastle; neither requires the other."*
- **Website (opencastle.dev):** the Observability section, `/dashboard` demo
  route, and hero "View dashboard" button on `index.astro` go away; the
  convoy recipes in `docs/use-cases.astro` (95 mentions) and the convoy entries
  in `docs/cli.astro` move to Convoy's docs or are cut. `deploy.yml` stops
  building and merging the dashboard entirely.
- **Announcement:** this is the 1.0 relaunch the refactoring plan already
  wants. "OpenCastle 1.0 — compile one config for every AI coding assistant"
  (Show HN / dev.to). The split is a supporting bullet, not the headline:
  *"1.0 is pure compiler: zero runtime dependencies. The experimental convoy
  engine moved to its own project."*

### 3.2 Convoy

- **Tagline (proposal):** "Watch your agents actually work." Sub-line: "A
  deterministic runner for long AI coding tasks — DAG-planned, crash-safe,
  live in your browser."
- **Category:** experimental task runner + live run viewer.
- **Audience:** individual power users running long or unattended agent jobs;
  people burned by a lost overnight run; the Gas Town-curious crowd. This is an
  early-adopter audience — write for them.
- **Vocabulary:** run, task, DAG, phase, worktree, gate, resume, viewer. Never
  "compile", "sync", "targets".
- **README leads with the viewer.** An animated capture of the live page during
  a real run is the hook — it is the one thing native background agents don't
  give you. Structure: GIF → `npx <pkg> "task"` → an honest "Experimental"
  banner → a short "why not just background agents?" FAQ (answers: crash
  resume, dependency-ordered phases, worktree isolation + merge queue, your own
  gates, and you can watch it).
- **Positioning against the ecosystem:** name Steve Yegge's Gas Town as the
  inspiration (as the README already does) and be explicit that Convoy is the
  small, resumable, single-repo take on the idea.
- **Announcement:** soft launch only — repo public, npm published, linked from
  OpenCastle's Related projects. No launch post until it graduates from
  experimental. This matches the "extract and freeze, don't delete" economics:
  spend brand-building effort only if it earns an audience.
- **Cross-referencing:** each README links the other exactly once, in a footer.
  Convoy's line: *"Convoy runs great alongside config compiled by OpenCastle,
  but neither requires the other."* That sentence is also the compatibility
  contract — keep it true.

### 3.3 Naming (decision needed)

Recon on npm (checked 2026-07-27):

| Name | Status | Note |
|---|---|---|
| `convoy` | **taken** | abandoned 2022 asset pipeline — also claims the `convoy` **bin**, so bare `npx convoy` misroutes to it |
| `convoy-cli` | **taken, live** | ish-cs/convoy — "Connect Claude Code to Convoy — share live working context across your team's sessions". **A live product named Convoy in the Claude Code ecosystem.** |
| `opencastle-convoy` | free | |
| `convoy-engine`, `convoy-runner` | free | |
| `@monkilabs/convoy` | free (scoped) | clunky as an npx entry point |

The ish-cs collision is the real issue: "have you tried Convoy?" is ambiguous
in exactly our niche.

**Recommendation: Option A now, revisit on graduation.**

- **A (recommended):** npm **`opencastle-convoy`**, display name "Convoy",
  bin `convoy`. `npx opencastle-convoy` is unambiguous; the bin works for
  global installs (`npm i -g` → `convoy`); only bare `npx convoy` misroutes,
  and no docs ever print that. The prefix keeps lineage/discoverability and
  soft-disambiguates from ish-cs. Costs: brand tie to OpenCastle — acceptable
  while experimental.
- **B:** a fresh standalone name. Cleanest long-term, kills the collision, but
  spends a naming/branding cycle on an experiment and orphans the "convoy
  engine" history. Right move **if and when** it graduates.
- **C:** `@monkilabs/convoy`. Clean namespace, weakest npx ergonomics. Not
  recommended as primary.

## 4. Evidence: the coupling map

Measured on `refactor/dx-first-compiler` at 757784c.

### 4.1 What the engine is

`src/orchestrator/` is **not** the engine — it is the compiler's content
library (agents/skills/plugins/prompts). The engine is:

| Area | Path | Non-test LOC |
|---|---|---|
| Engine core | `src/cli/convoy/` (24 files) | 10,059 |
| Execution layer + agent adapters | `src/cli/run/` (9 files) | 2,199 |
| Engine CLI commands | `src/cli/{convoy-cmd,run,plan,pipeline,watch,dashboard}.ts` | 3,738 |
| Engine tests | 32 files (incl. 2 dashboard-script tests) | ≈18,200 |
| **Total moving** | | **≈34,000** |

For contrast, the compiler product: `src/cli/*.ts` minus engine commands
(7,034) + `src/cli/adapters/` (1,284) + `src/orchestrator/plugins/**` (1,153),
19 test files.

### 4.2 Import edges (the boundary test's view)

- **Product → engine: zero** outside the 6 allowlisted command files
  (`boundary.test.ts` enforces; allowlist at `boundary.test.ts:70`).
- **Engine → product: 3 edges, 2 symbols** — the whole severable surface:
  - `src/cli/convoy/engine.ts:29` imports `c` (ANSI colors) from `../prompt.js`
  - `src/cli/run/reporter.ts:4` imports `c` from `../prompt.js`
  - `src/cli/run/reporter.ts:5` imports `appendEvent` from `../log.js`
- `src/cli/convoy/spec-types.ts` (262 LOC) + `src/cli/convoy/types.ts`
  (423 LOC, zero imports) form a self-contained type root — they lead the move.

### 4.3 The six couplings the boundary test cannot see

1. **`npm run build` transitively loads the engine.** `build` runs
   `dashboard:etl:empty` → `etl.ts` → dynamic import of `convoy/store.js`. The
   release currently cannot build without the engine compiling. (Four
   `src/dashboard/scripts/*` files import engine modules; `src/dashboard/` is
   outside the boundary test's walkers.)
2. **`src/cli/gitignore.ts:35-51`** hardcodes engine runtime paths
   (`.opencastle/logs`, `/worktrees`, `/artifacts`, `/baselines`, `*.db`,
   `*.ndjson`) into the managed gitignore block — string-level knowledge no
   import scan sees.
3. **`bin/cli.mjs:19-23`** suppresses Node's SQLite `ExperimentalWarning` — the
   comment itself calls it an engine implementation detail in the product
   entrypoint.
4. **Planner prompts:** `src/cli/plan.ts:296-303` reads
   `src/orchestrator/prompts/<name>.prompt.md` at runtime; `pipeline.ts` drives
   7 of the 14 by name (`generate-prd`, `validate-prd`, `fix-prd`,
   `assess-complexity`, `generate-convoy`, `validate-convoy`, `fix-convoy`).
   These same files are also compiled into user repos as slash commands
   (`prompts/*.prompt.md → .claude/commands/<name>.md`).
5. **One product test crosses:** `src/cli/agent-roster.test.ts:13` imports
   `AGENT_CONTRACTS` from `./convoy/contracts.js` to cross-check the agent
   roster against `src/orchestrator/agents/*.agent.md`.
6. **One build unit:** single-rootDir `tsconfig.json`, flat
   `vitest.config.ts` include, one `dist/`.

### 4.4 Runtime state ownership

The engine writes 14 distinct paths under `.opencastle/` (db + WAL, per-convoy
NDJSON under `logs/convoys/`, artifacts, worktrees, baselines, runs, ledgers,
inject dir, spec files). There is **no central path module** — literals across
8 engine files, plus product-side knowledge in `gitignore.ts`. Locking is a
SQLite `engine_lock` table (pid + heartbeat), not a file.

### 4.5 Dependency split

`@github/copilot-sdk` (copilot adapter only), `valibot` (event-schemas only),
`yaml` (6 engine files) — all engine. `node:sqlite` — engine only. `astro` and
plugins stay with OpenCastle (website); `playwright` is used only by
`tools/og-image` and `tools/demo-video` (marketing tooling — stays, though the
dashboard recording script it drives is retired in Phase B).

## 5. The live viewer (replaces the dashboard)

### 5.1 Scope

**Current run only.** DAG of tasks with live states, phase progress, a live
event feed, elapsed time and token/cost counters — all from rows the store
already keeps. No history, no aggregates, no per-agent analytics. If a section
needs the ETL to exist, it does not survive.

### 5.2 What exists to build on (surveyed)

- The **read path** already exists: `convoy-cmd.ts` `readLastRun()` →
  `store.getLatestConvoy()` + `getTasksByConvoy()`; `store.getEvents()` orders
  by rowid. The `engine_lock` table (pid + 30s heartbeat) answers "is this run
  actually alive".
- A **server** already exists: `src/cli/dashboard.ts` (~390 LOC, `node:http`,
  port 4300, localhost-only, path-traversal guarded) with an
  `/data/active-convoy.json` handler that queries the DB directly — the pattern
  to keep. Five auto-launch sites in `run.ts` open it on every run — behavior
  worth keeping.
- The **event contract** is real: 49 typed events (`convoy/types.ts`,
  valibot-validated in `event-schemas.ts`), `event.id` is a monotonic cursor.

### 5.3 Gaps to close

- `DashboardConvoyDetail.tasks[]` omits `depends_on` — the DAG edges are stored
  (`task.depends_on`, JSON array) but never reach the client. Expose them.
- No `getEventsSince(id)` accessor — today's "live" mode re-runs a **full ETL
  of every convoy every 3 seconds**. Add the cursor read; serve it over SSE
  (or long-poll) instead.
- The per-convoy NDJSON is written durably but never served; SQLite stays the
  viewer's source of truth (matches `TELEMETRY.md`, which also needs updating:
  it says 39 event types, actual 49, and names the NDJSON file wrong).

### 5.4 Design constraints

1. **One read path.** The text status (`convoy` bare) and the viewer must call
   the same store reads — extract `readLastRun()` into a shared module both
   use. Lesson from the `sync`/`sync --check` disagreement: two independent
   readers of the same state will eventually contradict each other.
2. **Strictly read-only.** The viewer opens the store, reads, closes. No new
   write paths, no new invariants.
3. **Self-contained.** One static HTML file (inline CSS/JS, no build step, no
   Astro) + `GET /api/state` + `GET /api/events?since=<id>`. Salvage the markup
   patterns from `index.astro`'s task table / summary cards / phase breakdown /
   event timeline render functions; rewrite small. Target ≤1,500 LOC total
   where the dashboard is ~7,000.
4. **The NDJSON stream stays the integration surface.** The viewer reads
   SQLite, but the documented per-convoy NDJSON is what a *future* external
   viewer would tail — keep writing it, document it, and keep the door open for
   the viewer to one day stand alone (§8, "viewer independence").

### 5.5 Deleted with the dashboard

`etl.ts` (169) and its 3 output shapes, `generate-demo-db.ts` (529) + tests,
`integration-test.ts` (504, never in CI), `verify-demo-data.sh`, `seed-data/`
(5 NDJSON), the Astro app (`index.astro` 2,313 + `dashboard.css` 2,943), the
`--seed` branch and legacy `DATA_FILES` allowlist in `dashboard.ts`, the
`dashboard:*` npm scripts, the dashboard steps in `deploy.yml`, and the
duplicated tier heuristic in `index.astro:1317-1350`. The npm tarball also
stops shipping `src/dashboard/dist/` (~272 KB today).

## 6. Work plan

Order matters: sever first (A), replace the dashboard while everything is still
in one repo (B), then move a finished, self-contained engine (C). Each phase
ships from `main`.

### Phase A — Sever the couplings (in-repo, ~1-2 days)

1. Cut the 3 import edges: give the engine its own ~40-line color module
   (`prompt.ts`'s other 500 LOC are product-only); give `run/reporter.ts` its
   own event append (the product's `log.ts` serves the installed content
   protocol and stays).
2. `agent-roster.test.ts`: drop the `convoy/contracts.js` import — the expected
   roster list moves into the test (or compiler content). `contracts.ts` stays
   engine-side (it feeds `validateOutput` in the review gates).
3. Copy the 7 planner prompts into `src/cli/convoy/prompts/` and point
   `plan.ts`/`pipeline.ts` there. Remove them from the compiled slash-command
   set — a user without Convoy gets commands that drive a tool they don't have.
   The other 7 prompts stay compiler content. (Decision to confirm: anyone
   using `/generate-prd` standalone? Assumed no.)
4. Move engine runtime state from `.opencastle/` to **`.convoy/`**. This is the
   moment to do it: it makes ownership self-evident and dissolves coupling #2 —
   `gitignore.ts` stops writing engine paths; Convoy manages its own gitignore
   lines (one `.convoy/` entry). One-time adoption: if `.opencastle/convoy.db`
   exists and `.convoy/` doesn't, offer to move db + logs (+ prune the old
   gitignore entries on the next `sync`).
5. Move the SQLite warning filter from `bin/cli.mjs` into the engine's entry.
6. Untangle the build: `npm run build` becomes `cli:build` only (dashboard
   scripts die in Phase B; until then, keep `dashboard:etl:empty` runnable but
   out of `build`). Split vitest into two projects (`compiler`, `engine`) so
   the suites are separable before the repos are.

Exit criteria: boundary test passes with an **empty** engine→product edge set;
`npm run build` completes with `src/cli/convoy/` and `src/cli/run/` deleted
from a scratch checkout (throwaway verification, not committed).

### Phase B — Build the live viewer, delete the dashboard (in-repo, ~2-4 days)

1. Store: add `getEventsSince(convoyId, afterId)`; expose `depends_on` in the
   detail projection.
2. Extract the shared status read; rewrite `dashboard.ts` as the small server
   (§5.4); build the single-page viewer; keep the five auto-launch sites and
   `convoy dashboard`.
3. Delete everything in §5.5. Update `TELEMETRY.md` (49 types, correct paths).
4. Website: remove the `/dashboard` demo route, Observability section, and
   dashboard build steps from `deploy.yml` (OpenCastle's site should not demo
   Convoy's product — Convoy's README GIF does that now).

Exit criteria: `opencastle convoy "<task>"` opens the viewer and shows a run
progressing live; `npm test` green; `deploy.yml` ships the website with no
dashboard artifacts.

### Phase C — Physical extraction (~2-3 days)

1. New repo scaffold: `bin/` (with the warning filter), `src/` =
   `convoy/` + `run/` + the 6 command files + `prompts/` + viewer assets +
   tests; `package.json` (name per §3.3, bin `convoy`, deps: the 3 + tsx/tsc/
   vitest toolchain); own `tsconfig`, `vitest.config`.
2. Preserve history: `git filter-repo` on a clone, keeping the engine paths —
   the convoy engine's history (it largely built itself) is part of its story.
3. CLI shape in the new repo: `convoy "<task>"`, `convoy` (status), `resume`,
   `retry`, `run`, `plan`, `dashboard` — i.e. today's namespace promoted to
   top level. Same state-aware, zero-flags-golden-path principles.
4. CI: copy `ci.yml` (tsc + vitest) and the auto-semver `publish.yml` pattern
   (idempotent republish guard included). No pages deploy.
5. Port the relevant `verify-claims` idea: a small script driving the real CLI
   through crash → resume and checking the viewer's `/api/state` answers.

### Phase D — OpenCastle cleanup + 1.0 (~1-2 days)

1. Delete `src/cli/convoy/`, `src/cli/run/`, the 6 command files and their
   tests. `opencastle convoy` joins the `REPLACED` map in `bin/cli.mjs` for at
   least one minor release: *"The convoy engine is now its own project — run:
   npx opencastle-convoy"*. Remove `convoy` from HELP's Experimental section.
2. Dependencies to zero; `boundary.test.ts` keeps its root-file/managed-block
   guards, drops the engine sections, gains one grep: no `from './convoy/` or
   `'./run/` anywhere in `src/`.
3. README (`## Convoy Engine` → Related projects footer), quickstart §Convoy,
   `ARCHITECTURE.md:290`, and the website convoy/dashboard content (§3.1).
   `docs-accuracy.test.ts` fixtures updated from real runs.
4. Ship as **1.0.0** — the relaunch release. The split is the changelog's
   supporting act (§3.1).

### Phase E — Communication execution (~1-2 days)

1. Record the OpenCastle config-lift demo (the relaunch blocker the previous
   plan already names) and a Convoy viewer GIF over a real run
   (`tools/demo-video/` retargets or retires).
2. Write both README footers with the exact cross-reference sentences (§3.2).
3. Release notes for the last 0.x: what moved, the one-command migration, link
   to the new repo. npm README of the old versions is immutable — the deprecation
   shim in D1 is what reaches existing users.
4. OpenCastle 1.0 launch post; Convoy soft launch only.

## 7. Migration for existing users

Honestly sized: convoy's real-world usage is single-digit users (the plan's own
audit). The migration is therefore a courtesy, not an engineering program:

- `opencastle convoy …` prints the replacement command for ≥1 minor release.
- First run of the new tool in a repo with `.opencastle/convoy.db` offers the
  one-time state move to `.convoy/` (A4). SQLite schema migrations
  (`SCHEMA_VERSION`, currently 12) carry over unchanged.
- `opencastle sync` (already the documented upgrade step) rewrites the managed
  gitignore block without the engine paths.
- One paragraph in the release notes covers all of it.

## 8. Risks and open decisions

| # | Risk / decision | Position |
|---|---|---|
| 1 | **Naming** (§3.3): ish-cs "Convoy" collision in the same ecosystem | Option A now (`opencastle-convoy`), rename only on graduation. Needs Filip's sign-off. |
| 2 | **Two repos = two maintenance surfaces** for a project with ~338 downloads/30d | Accepted deliberately: it's the point of the split (stable vs experimental cadence). Convoy's CI is a copy of a proven pipeline; if Convoy finds no audience, freezing a separate repo costs nothing — same economics as Phase 4's "extract and freeze". |
| 3 | **History**: filter-repo vs fresh start | Recommend filter-repo (keep history); fallback is fresh-start with a "history lives in opencastle ≤0.x" note. Low stakes. |
| 4 | **Planner prompts as slash commands** (A3): does anyone drive `/generate-prd` by hand? | Assumed no; if wrong, Convoy ships its own command installer later — do not keep the compiler installing engine prompts. |
| 5 | **Viewer independence**: should the viewer become a third project? | No — a viewer with one possible data source is a folder split, not a product. The NDJSON contract (§5.4) is the door left open; revisit only if another engine wants to emit it. |
| 6 | **`opencastle.dev/dashboard` demo disappears** — the website loses its only interactive artifact | Accepted: it demoed cut features against fake data. The Convoy README GIF over a *real* run is the honest replacement. |
| 7 | **Contracts stay engine-side** (A2) but describe agents whose definitions live in OpenCastle content | Acceptable drift risk while experimental; the real fix (contracts declared in the convoy spec, not hardcoded) is a Convoy-repo issue, not a split blocker. |
| 8 | **Copilot SDK / agent-CLI scraping treadmill** moves to Convoy unchanged | Unchanged risk, now correctly priced: it destabilizes an experimental tool, not the compiler release train. |

## 9. Outcome

| Metric | Today (one repo) | OpenCastle after | Convoy after |
|---|---|---|---|
| One-sentence purpose | two, entangled | compiler | runner + viewer |
| Runtime npm deps | 3 | **0** | 3 |
| Non-test LOC | ~26k + 7k dashboard | ~9.5k (+ content) | ~16k + ≤1.5k viewer |
| Test files | 51 | 19 | 30 (+ viewer tests) |
| CLI surface | 6 + convoy namespace | 6 | 7 top-level |
| Runtime state dir | `.opencastle/` (shared) | `.opencastle/` (manifest only) | `.convoy/` |
| Release cadence | one train | stable, 1.0 | experimental, 0.x |
| npm build loads engine | yes (via ETL) | no | n/a |

Total effort estimate: **7-13 working days**, sequential phases, `main`
shippable after each.
