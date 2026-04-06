# Codex Runtime Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real `codex` runtime support so `opencastle start/run/plan --adapter codex` can load and execute through Codex CLI.

**Architecture:** Add a new runtime adapter under `src/cli/run/adapters/` that shells out to `codex exec` in non-interactive mode and captures the final agent response via `--output-last-message`. Register that adapter in the runtime registry, extend runtime adapter help text to include Codex, and add focused tests around registry loading and execution behavior.

**Tech Stack:** TypeScript, Node.js child processes, Vitest

---

### Task 1: Add the Codex runtime adapter

**Files:**
- Create: `src/cli/run/adapters/codex.ts`

**Step 1: Write the adapter module**

Implement a new runtime adapter with:
- `name = 'codex'`
- `isAvailable()` using `which codex`
- `execute()` using `codex -a never exec -s workspace-write --color never --skip-git-repo-check --ephemeral -C <cwd> -o <tmpfile> <prompt>`
- `kill()` mirroring existing CLI adapters

**Step 2: Capture final output robustly**

Use a temporary directory for `--output-last-message`, return that file’s contents on success, and fall back to combined stdout/stderr on failures.

**Step 3: Clean up temp files**

Remove the temp directory in a `finally` block after process completion.

### Task 2: Register Codex as a runtime adapter

**Files:**
- Modify: `src/cli/run/adapters/index.ts`
- Modify: `src/cli/plan.ts`
- Modify: `src/cli/run.ts`

**Step 1: Register the adapter**

Add `codex` to the runtime adapter registry and append it to detection order.

**Step 2: Fix runtime help text**

Update the adapter install/error hints in `plan.ts` and `run.ts` so Codex is listed as a supported runtime adapter with a correct installation hint.

### Task 3: Add focused tests

**Files:**
- Create: `src/cli/run/adapters/codex.test.ts`

**Step 1: Write registry and availability tests**

Cover `getAdapter('codex')` loading and `isAvailable()` behavior with mocked `spawn`.

**Step 2: Write execution tests**

Cover successful execution through `--output-last-message`, expected Codex CLI args, and failure fallback output handling.

### Task 4: Verify the patch

**Files:**
- Test: `src/cli/run/adapters/codex.test.ts`

**Step 1: Install dependencies if needed**

Run: `npm install`

**Step 2: Run focused tests**

Run: `npm test -- src/cli/run/adapters/codex.test.ts`

Expected: PASS

**Step 3: Run a build check**

Run: `npm run cli:build`

Expected: PASS
