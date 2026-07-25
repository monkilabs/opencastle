# OpenCastle Strategic Refactoring Plan

_Date: 2026-07-25. Status: proposal._

## 1. Where the project stands

**Trajectory.** Born 2026-02-26. 356 commits: 254 in March, 58 in April, 5 in May, zero since May 18. npm launch spike peaked ~1,100 downloads/day in early March; last 30 days: ~338. No open GitHub issues. The project is dormant, not dead — CI, publish automation, and tests (1,489 vitest tests) are all healthy.

**Real usage.** Dogfooding was intense for ~2 weeks in March (the convoy engine built itself: 48 implementation prompts, 7 real convoys, 28 tasks, ~$0.09 recorded LLM spend), one bugfix session on Apr 20, then nothing. The seemingly rich knowledge ledgers (`AGENT-FAILURES.md` 1.6 MB / 6,599 entries, `DISPUTES.md` 283 KB / 921 disputes, `LESSONS-LEARNED.md` 464 KB) are ~97% vitest pollution — the engine resolves ledger paths from `process.cwd()`, so the test suite has been writing into the repo's live `.opencastle/` since March.

**Why the premise aged.** The founding bet was that users need a pre-built 19-agent org chart plus a deterministic orchestration engine. Since February, the platforms shipped that natively: Claude Code has first-class subagents, skills, plugins, a plugin marketplace, agent teams, and background/cloud execution; Copilot, Cursor, and Codex followed similar arcs. A frontier model with a good harness now does what the Team Lead + specialist choreography was designed to force. Users didn't stop wanting help — they stopped wanting *complex setups*.

## 2. Asset audit

### Genuinely valuable (keep and sharpen)

| Asset | Evidence | Why it survives |
| --- | --- | --- |
| **Multi-IDE installer + adapters** (`src/cli/` init/update/eject/destroy/doctor + `adapters/`, ~6.5k LOC) | Clean, modular, zero convoy coupling. 4 of 7 adapters are ~30-line configs over a shared factory. | Nobody else compiles one config source to 7 assistant formats. This is the moat. |
| **Stack detection + plugin/MCP wiring** (`detect.ts` 707 LOC, `mcp.ts`, `skill-matrix.json`, 30+ typed plugins) | Detects lockfiles/frameworks/monorepos; emits MCP config in each IDE's native format; binds abstract capability slots (`framework`, `database`, …) to concrete skills at init. | Auto-configured, stack-aware setup is still a real "first 5 minutes" win. |
| **Protocol wiring in content** | Parseable reviewer verdict blocks, review auto-pass carve-outs with thresholds, sensitive-path overrides, lessons-learned graduation protocol. | The non-generic ~30% of the content. Cheap to keep, hard to reinvent. |
| **Convoy minimal core** (~6–7k LOC: store/events/lock, DAG scheduler skeleton, worktree+merge+partition, adapters, fast review, secret gate) | Well-tested (test:source ≈ 1.35:1), real crash recovery. | Solid engineering — but see §4: the use case, not the code, is the problem. |
| **Release/CI automation, tessl skill scoring** | Auto-semver publish on merge; `scripts/review-skills.ts` backs the quality claims. | Working infrastructure; keep. |

### Obsolete or negative-value (cut)

| Liability | Evidence | Action |
| --- | --- | --- |
| **19-agent role sprawl** | 60–70% of agent/skill prose is generic advice frontier models already follow; Copywriter/SEO/Docs-Writer overlap; API Designer ⊂ Developer+Architect. | Merge to ~10; strip generic filler. |
| **Hardcoded fictional model names** | `Claude Opus 4.7`, `GPT-5.5-Codex`, `Gemini 3.1 Pro` pinned in 19 agent files + registry + skill examples + engine map + pricing tables + website — all drifting independently (see TAS-101, "Replace GPT-5.4 with GPT-5.4"). | Delete model pinning everywhere; tiers only, resolved in ONE registry at compile time, defaulting to "let the IDE choose". |
| **Convoy "intelligence" suite** (~900 LOC + engine glue) | Disputes (management CLI is a stub), panel reviews (0 real disputes ever), circuit breaker (never tripped), expertise/knowledge graph/skill refinement (only demonstrated behavior: repo pollution), compaction (off by default). Most are silently-failing `try/catch` prompt injections with single call sites. | Delete from engine. |
| **Plugins content bloat** | 40K words (~half of all installed content), much of it framework-docs recap. | Keep the typed config/MCP wiring; cut each SKILL.md to sharp, non-obvious guidance only. |
| **Snippet "Inherits:" layer** | 4 snippets, 62 lines, no build-time inlining, 3rd indirection layer. | Inline and delete the concept. |
| **Dashboard beyond its core** | ~8k LOC for one page; 9 of 16 sections visualize features being cut; demo-DB generator runs in BOTH deploy and publish CI (schema change ⇒ broken release); integration test not in CI; `generate-seed-data.ts` dead. | Keep KPI/list/tasks/timeline core (~1/3), decouple demo pipeline from publish, delete dead paths. |
| **Misc dead weight** | `export.ts` tombstone + its test, `dispute.ts` stub advertised in help, legacy NDJSON sessions path, duplicated cursor↔windsurf adapters (~350 LOC), misnamed peer dep `@anthropic-ai/agent-sdk` (published name is `@anthropic-ai/claude-agent-sdk` — the SDK path likely never activates). | Delete/fix. |

## 3. The new focus: one clear use case

> **OpenCastle is the build system for AI-assistant configuration.**
> Define your project's AI setup once — rules, agents, skills, MCP servers — and OpenCastle compiles it for every assistant your team uses, keeps it in sync, and fails CI when it drifts.

Why this wins:

1. **The pain is growing, not shrinking.** Every assistant added its own primitives and file formats (`CLAUDE.md` + `.claude/`, `AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md`, `GEMINI.md`, `.windsurf/`…). Teams are polyglot — Copilot via work license, Claude Code by preference, Cursor on some machines. Config sprawl and drift is the 2026 problem, exactly like build-tool sprawl before Babel/Vite.
2. **It's what already works in this repo.** The installer layer is the clean 6.5k LOC; adapters cost ~30 lines each; detection, MCP transformation, manifest-driven `update`/`doctor` all exist and are tested.
3. **It's platform-proof.** When assistants add primitives, OpenCastle gains an adapter feature instead of losing its reason to exist. Native marketplaces distribute *content*; nobody owns *cross-assistant compilation and sync*.

**Positioning: adopt AGENTS.md as the canonical source format** (extended with an `opencastle.yml` or frontmatter for what the standard doesn't cover: skills, MCP, per-agent scopes). Pitch OpenCastle as the reference toolchain for the open standard rather than a proprietary format. "Write AGENTS.md, get every assistant configured."

### DX is the product

OpenCastle targets developers; for a dev tool in this category, DX *is* the product — positioning only earns the first visit, ramp-up speed and visible value earn the second. Every phase below is subordinate to these commitments:

1. **Time-to-value under 2 minutes, and the value must be *visible*.** Today `init` ends with ~200 markdown files silently installed — the value is diffuse and deferred. The redesigned first run must end with a demonstrable before/after: run `npx opencastle init` on a repo that already has a `CLAUDE.md`, and it detects it, lifts it, and emits working config for every other assistant — then prints a summary tree of what was created and why. "I had config for one assistant; one command later I have all seven, in sync" is the aha moment, and it's honest — the installer already does the hard part.
2. **The tool narrates its own value.** Bare `opencastle` status ("6 targets in sync, 1 stale — run `opencastle sync`"), drift shown as a familiar git-style diff, `doctor` findings paired with ready-to-run fix commands. Invisible work is unvalued work.
3. **Nothing surprising, nothing slow.** Sensible defaults everywhere; destructive operations preview first; init completes in seconds, not a nine-screen questionnaire (§6).
4. **Docs match the funnel.** One 5-minute quickstart page as the canonical entry; kill the doc sprawl explaining 19 agents and 5 model tiers. The README leads with a 30-second gif of the config-lift moment, not an architecture diagram.
5. **Errors are DX.** Every error message names the fix or the command that finds it. (`doctor` already points this direction; make it the standard.)

## 4. Decision: the convoy engine

Recommendation: **extract and freeze, don't delete.**

- The execution substrate (scraping stdout of 5 third-party CLIs + 2 pre-1.0 SDKs) is a maintenance treadmill no dormant project can afford, and native background/cloud agents are eating the "run it overnight" job.
- But the core (SQLite+NDJSON crash recovery, DAG phases, worktree isolation/merge queue) is real, well-tested work worth preserving.
- Move it to `packages/convoy` (or a separate repo `opencastle-convoy`), slim it to the ~6–7k-LOC core with **one** first-class adapter (Claude Code via the real `@anthropic-ai/claude-agent-sdk`, which supports programmatic sessions properly), label it experimental, and stop advertising it as half the product. If it finds an audience, revive; if not, it cost nothing.
- Dashboard follows the same split: the durable core stays as the convoy package's viewer; the marketing demo becomes a static build not wired into `publish.yml`.

## 5. New capabilities (the "attractive again" part)

Ordered by adoption impact:

1. **`opencastle import`** — read the user's *existing* `CLAUDE.md` / `.cursor/rules` / `copilot-instructions.md` and lift them into the canonical source, then compile back out to all targets. Kills the biggest adoption barrier: nobody starts from scratch in mid-2026; every active repo already has assistant config. This turns "adopt our framework" into "keep what you have, gain the other six IDEs."
2. **`opencastle check`** — CI mode: fail when generated files drift from source (like `prettier --check`). Ship a 5-line GitHub Action. This creates the daily-touch habit and the team-workflow lock-in that `init` alone never had.
3. **Packs** — reframe the existing plugin system as installable presets: `opencastle add nextjs-supabase-vercel`. The typed plugin configs, MCP wiring, and skill-matrix slots already implement 90% of this; it just needs naming, docs, and a community contribution path.
4. **`opencastle lint`** — the tessl evaluator + skill-failure telemetry, generalized: warn on generic filler, stale/unknown model names, oversized skills, broken inherits links. (It would have caught this repo's own TAS-101 and website drift.) Positions OpenCastle as the quality tool for the config it compiles.

## 6. Usage simplification: the CLI

The current surface is 19 top-level commands and ~60 distinct flags (`run` alone parses 20 — status, resume, retry, DLQ list/resolve/retry, formula templating, watch mode are six sub-products inside one arg parser; `plan` has 11, `start` 10, `lesson` 10). The help screen asks users to understand a seven-step PRD pipeline before they can run anything, and `init` walks through an IDE select plus **nine** multiselect screens. This is the adoption killer independent of positioning.

### Design principles

1. **One command per user job, zero flags on the golden path.** Flags may modify a job, never define it. If a job needs a flag to work, it's a missing command or a missing default.
2. **State-aware instead of flag-driven.** The tool knows whether a run crashed, whether targets drifted, whether config exists. `opencastle` with no arguments should *tell the user what to do next*, and verbs like resume should be offered automatically when the state calls for them — not memorized as `--resume`/`--retry-failed`/`--dlq-retry` combinations.
3. **Detection over interrogation.** `init` already detects the IDE and stack; show one summary screen with a single confirm. The nine multiselects become `init --customize` for the minority who want them; `--yes` for CI.
4. **Config file over flags.** Anything persistent (adapter choice, watch/formula settings) belongs in `opencastle.yml`, not in per-invocation flags.
5. **Separate the audiences.** `log` and `lesson` are called *by agents*, not humans — they must not appear in human help. Hidden `internal` namespace.
6. **Progressive disclosure.** Default help shows ≤6 commands. Everything else behind `opencastle help --all`.

### Proposed surface

| New | Replaces | Behavior |
| --- | --- | --- |
| `opencastle` (no args) | — | Status: what's installed, target freshness/drift, suggested next command. |
| `opencastle init` | `init` | Detect stack + IDEs + **existing assistant config** (absorbs `import` from §5) → summary → one confirm. `--customize`, `--yes`. |
| `opencastle sync` | `update` | Compile canonical source → all targets. `sync --check` is the CI drift mode (§5). |
| `opencastle add <pack>` | plugin selection re-runs | Add an integration/pack after init. |
| `opencastle doctor` | `doctor` | Deep diagnostics (setup, MCP env vars, broken links). |
| `opencastle remove` | `eject` + `destroy` | Interactive: keep files (eject semantics) or remove everything. |
| `opencastle convoy "<task>"` | `start` + `plan` + `validate` + `run` | Experimental namespace, one entry point: plan → spec → run with sensible defaults; validation implicit. |
| `opencastle convoy` (no args) | `run --status/--resume/--retry-failed/--dlq-*` | Shows run state; offers resume/retry when a crashed or failed run exists. |

**Cut outright** (with the features they serve): `dispute` (stub), `validate` (implicit), `insights`, `artifacts` (auto-prune), `agents`, `baselines`, `watch`/`--formula`/`--set`, `skills` (folds into `lint` later), `package` (revisit after repositioning). `dashboard` moves under `convoy dashboard`.

Net: **19 commands → 6 visible + 1 experimental namespace**; global flags standardized to `--dry-run`, `--yes`, `--json`, `--quiet`, `--help`; per-command flags capped at ~3 visible.

## 7. Execution plan

### Phase 0 — Hygiene (days; do regardless of strategy) — ✅ DONE
- ✅ Route all ledger/DB paths through an injected root, never `process.cwd()`; point tests at tmp dirs; purge the polluted `.opencastle/` ledgers. Also fixed unbounded blank-line growth in `consolidateLessons` and a dispute writer that never created its parent directory. Guard test added.
- ✅ Fix KI-003 (crashed convoys stuck `running`) — `markConvoyCrashed` on both entry points, 4 tests.
- ✅ **Deviation from plan:** the peer dep was not merely misnamed. `@anthropic-ai/agent-sdk` does not exist; the real `@anthropic-ai/claude-agent-sdk` exports `query()`, while the adapter called `AgentClient`/`approveAll`/`sendAndWait` — absent from the published types. Renaming would have converted a dead branch into a runtime crash, so the SDK path, its stubs, the peer dep, and its three mock-only tests were **removed**. A real SDK adapter against `query()` is Phase 4 work.
- ✅ Delete `export.ts`, `generate-seed-data.ts`, legacy `.github/customizations/logs` path, `dispute.ts` stub (and its help entry). 627 lines removed.
- ✅ Deduplicate cursor/windsurf adapters: 835 → 424 LOC via `createRulesDirAdapter`, verified byte-identical on 492 golden-manifest entries, plus 24 new tests (these adapters had none).
- **Open finding for later:** instructions are written with `alwaysApply: true` even when the source declares a narrow `applyTo` glob, so on Cursor a scoped instruction widens to every file. Pinned by test; fix belongs with the canonical-source work in Phase 3.

### Phase 1 — Reposition — ✅ DONE
- ✅ CLI simplification (§6): 19 commands → 6 visible + `convoy` namespace. Bare `opencastle` and bare `opencastle convoy` read state and name the next command, replacing the `--status`/`--resume`/`--retry-failed`/`--dlq-*` flag families. `remove` merges eject+destroy; `sync` renames `update` (alias kept); `add <pack>` is new. Removed commands print their replacement. Tests: status (8), dispatcher (12), remove (13).
- ✅ One-confirm `init`: detection replaces an IDE picker plus nine multiselects. Measured ~1s on a repo with CLAUDE.md + next/supabase/vitest, correct detection, user's CLAUDE.md untouched. `--customize` keeps the old flow, `--yes` for CI. Tests: 11.
- ✅ Model pinning removed from all five locations; `src/cli/tiers.ts` is the single registry. Tests: 12, including a scan that no shipped file names a model.
- ✅ README + ARCHITECTURE rewritten around the compiler pitch; dropped the false "51 skills" claim and the init gif (it shows the flow that no longer exists — **a replacement recording is needed for relaunch**). Tests: 12, counts read from the tree.
- ✅ Website: hero, tier cards, agent list, stats, and the whole CLI reference page rewritten. Guard extended to the website — it caught two stragglers.

### Phase 2 — Content diet (in progress)
- ✅ **2a:** Agents 19 → 13. Merges: Copywriter+SEO+Docs → Writer; Data Expert+Database Engineer → Data Engineer; Release Manager → DevOps & Release; API Designer → Developer; Session Guard dropped. **Deviation:** the plan said "~10"; 13 is where the real seams are. Performance Expert, Content Engineer, and Researcher were kept because their scopes do not overlap anything else — over-merging would have destroyed genuine specialisation to hit a number. Surfaced and fixed a real bug: optional contract fields were never validated. Tests: 16.

- ✅ **2b/2c/2d:** Content 89,400 → 56,957 words (36%); plugins 37,236 → 10,201 (73%). Snippets inlined and the directory deleted. **Two shipping bugs found and fixed:** (1) `snippets/` was never installed by any adapter, so all 13 agents linked to a nonexistent file and the mandatory-logging rule never reached any agent; (2) plugin `references/` and `REFERENCE.md` were never installed either (only SKILL.md is read), so convex's 16-file references directory was dead weight *and* its SKILL.md routed readers to missing files — its hard limits are now inline. Note the asymmetry: *skill* REFERENCE.md files **are** installed and were left alone. Also deleted `backbone-scaffolding` (documented a different MonkiLabs product, bound to nothing).
- **Did not reach the ~30K target.** Remaining weight is prompts (12.7K), customizations (8.4K), and agent-workflows (6.3K), which were out of 2b's scope. Four content agents were interrupted mid-pass by a session limit, so protocol skills got only a partial sharpening pass.

### Phase 3 — Product work (in progress)
- ✅ **3a — config-lift:** root instruction files are now *merged*, not skipped. Found that the previous skip-if-exists behaviour meant the instructions layer silently never installed on a repo that already had a CLAUDE.md — the exact adoption case — and that `update` deleted the user's root file outright. Generated content now lives in a marked block; user content is preserved and never overwritten. Verified idempotent.
- ✅ **3b — `sync --check` + GitHub Action:** compiles to a scratch dir and byte-compares; exits non-zero on drift. **Found and fixed a dead end this created:** `sync` gated on version equality, so `--check` could report drift while `sync` said "already up to date" — the two commands disagreed. Sync now decides on content.
- **3c — lint v1:** not started.
- **3d — canonical source (AGENTS.md + opencastle.yml):** not started. The managed-block work in 3a is the foundation it needs.

### Phase 4 — Convoy extraction (1 week)
- Move `src/cli/convoy/` + `run/` + dashboard core to `packages/convoy`, slim to minimal core, one adapter (claude-agent-sdk), mark experimental.
- Decouple demo-DB/ETL from `publish.yml`; keep a static dashboard demo for the website.

### Phase 5 — Relaunch
- v1.0.0 with the new story. Show HN / dev.to round two: "Your AI assistant config is sprawling across 7 formats — we built the compiler." The GITHUB-STARS-STRATEGY.md playbook from March still applies; the product finally matches a felt pain.

### Success metrics (DX-first)
- **Time-to-visible-value < 2 minutes**: `npx opencastle init` on a repo with existing assistant config ends with lifted + compiled targets and a summary of what changed. Test this on real repos, timed.
- **Quickstart completable in 5 minutes** by someone who has never seen the project; validate with 2–3 cold users before relaunch.
- **Second-session signal**: `sync --check` adopted in ≥1 external CI within a month of relaunch — the retention proof `init` alone never produced.
- Maintenance surface: ~46.5k → ~15k LOC core product; visible CLI surface 19 commands → 6.
- npm weekly downloads recovering past the March organic baseline (~200/wk) without a launch spike.
