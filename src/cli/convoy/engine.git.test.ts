/**
 * The engine against real git repositories, with stub agents.
 *
 * Each test here reproduces a way the old engine lost or misreported work —
 * see the audit in the convoy rework — and checks the history it leaves behind,
 * not only the statuses it records.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createConvoyEngine, defaultBranchName, type ConvoyEngineOptions } from './engine.js'
import { createConvoyStore } from './store.js'
import { ensureRootWorktree, listAllWorktrees } from './worktree.js'
import { _resetAllowlistCache, _setAllowlistConfigPath } from './gates.js'
import type { AgentAdapter, ExecuteOptions, ExecuteResult, Task, TaskSpec } from './spec-types.js'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'convoy-git-')))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(repo, 'README.md'), '# proj\n')
  writeFileSync(join(repo, '.gitignore'), '.opencastle/\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  _setAllowlistConfigPath('/nonexistent/secret-scan-config.yml')
  _resetAllowlistCache()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

type Behaviour = (task: Task, options: ExecuteOptions) => Promise<ExecuteResult> | ExecuteResult

/** An agent that runs `behaviour` in the worktree it is given. */
function stubAdapter(behaviour: Behaviour, name = 'stub'): AgentAdapter & { execute: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  return {
    name,
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn(async (task: Task, options: ExecuteOptions = {}) => behaviour(task, options)),
    kill: vi.fn(),
  } as unknown as AgentAdapter & { execute: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
}

/** Writes `<task id>.txt` in its worktree, or whatever the task names. */
const writesOwnFile: Behaviour = (task, options) => {
  writeFileSync(join(options.cwd!, `${task.id}.txt`), `${task.id}\n`)
  return { success: true, output: 'done', exitCode: 0 }
}

function spec(tasks: Array<Partial<Task> & { id: string }>, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    name: 'Git Convoy',
    concurrency: 2,
    on_failure: 'continue',
    adapter: 'stub',
    defaults: { review: 'none' },
    tasks: tasks.map((t) => ({
      prompt: `Do ${t.id}`,
      agent: 'developer',
      timeout: '30s',
      depends_on: [],
      files: [],
      description: t.id,
      max_retries: 0,
      ...t,
    })),
    ...extra,
  }
}

function engine(opts: Partial<ConvoyEngineOptions> & Pick<ConvoyEngineOptions, 'spec' | 'adapter'>) {
  return createConvoyEngine({
    specYaml: 'name: git-convoy',
    basePath: repo,
    handleSignals: false,
    output: { write: () => true, isTTY: false },
    ...opts,
  })
}

function filesOn(branch: string): string[] {
  return git('ls-tree', '--name-only', '-r', branch).split('\n').filter(Boolean).sort()
}

describe('work lands on a branch of its own', () => {
  it('keeps every one of 8 parallel tasks, and leaves the user’s checkout alone', async () => {
    const before = git('rev-parse', 'HEAD')
    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i + 1}`, files: [`t${i + 1}.txt`] }))
    const result = await engine({ spec: spec(tasks, { concurrency: 8 }), adapter: stubAdapter(writesOwnFile) }).run()

    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(8)
    expect(result.branch).toBe(defaultBranchName('Git Convoy', result.convoyId))
    expect(result.baseRef).toBe('main')
    // All eight on the branch…
    expect(filesOn(result.branch!)).toEqual(['.gitignore', 'README.md', ...tasks.map((t) => `t${t.id.slice(1)}.txt`)].sort())
    // …and none of it in the user's checkout, which is where it was, clean.
    expect(git('rev-parse', 'HEAD')).toBe(before)
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git('status', '--porcelain')).toBe('')
    // The integration worktree is gone; the branch is the result.
    expect((await listAllWorktrees(repo)).map((w) => w.path)).toEqual([repo])
  })

  it('refuses to merge into the branch the user has checked out', async () => {
    const adapter = stubAdapter(writesOwnFile)
    await expect(engine({ spec: spec([{ id: 'a' }], { branch: 'main' }), adapter }).run()).rejects.toThrow(/checked out/)
    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('writes the event log to the main repository, never into a worktree it removes', async () => {
    const result = await engine({ spec: spec([{ id: 'a', files: ['a.txt'] }]), adapter: stubAdapter(writesOwnFile) }).run()
    expect(result.logPath).toBe(join(repo, '.opencastle', 'logs', 'convoys', `${result.convoyId}.ndjson`))
    const lines = readFileSync(result.logPath!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string })
    expect(lines.map((l) => l.type)).toContain('task_merged')
    expect(lines.map((l) => l.type)).toContain('convoy_finished')
  })
})

describe('the change is committed before anything checks it', () => {
  it('secret_scan sees an uncommitted file the agent wrote', async () => {
    // Gates diffed base..HEAD before anything was committed, so a secret the
    // agent left uncommitted was never scanned.
    const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB'
    const adapter = stubAdapter((_task, options) => {
      writeFileSync(join(options.cwd!, 'config.ts'), `export const token = "${token}"\n`)
      return { success: true, output: 'done', exitCode: 0 }
    })
    const result = await engine({
      spec: spec([{ id: 'leaky', files: ['config.ts'] }], { defaults: { review: 'none', built_in_gates: { secret_scan: true } } }),
      adapter,
    }).run()

    expect(result.status).toBe('failed')
    const store = createConvoyStore(join(repo, '.opencastle', 'convoy.db'))
    const task = store.getTask('leaky', result.convoyId)!
    store.close()
    expect(task.status).toBe('gate-failed')
    expect(task.output).toContain('secret_scan')
    // Reported without quoting the secret.
    expect(task.output).not.toContain(token)
    expect(filesOn(result.branch!)).not.toContain('config.ts')
  })
})

describe('merge conflicts', () => {
  it('re-runs the conflicting task once, from the tip that now holds the other change', async () => {
    const prompts: Record<string, string[]> = {}
    const adapter = stubAdapter(async (task, options) => {
      ;(prompts[task.id] ??= []).push(task.prompt)
      // Neither declared shared.txt, so both run at once and both write it.
      writeFileSync(join(options.cwd!, 'shared.txt'), `from ${task.id}\n`)
      if (task.id === 'b') await new Promise((r) => setTimeout(r, 50))
      return { success: true, output: 'done', exitCode: 0 }
    })
    const result = await engine({ spec: spec([{ id: 'a' }, { id: 'b', max_retries: 1 }]), adapter }).run()

    expect(result.status).toBe('done')
    expect(prompts.a).toHaveLength(1)
    expect(prompts.b).toHaveLength(2)
    expect(prompts.b[1]).toContain('conflicted with work merged while you ran, in: shared.txt')
    expect(prompts.b[1]).toContain('### Instructions\nDo b')
    expect(git('show', `${result.branch}:shared.txt`)).toBe('from b')
  })

  it('fails the task and keeps its branch when no retry is left for a re-run', async () => {
    const adapter = stubAdapter(async (task, options) => {
      writeFileSync(join(options.cwd!, 'shared.txt'), `from ${task.id}\n`)
      if (task.id === 'b') {
        writeFileSync(join(options.cwd!, 'b-only.txt'), 'b\n')
        await new Promise((r) => setTimeout(r, 60))
      }
      return { success: true, output: 'done', exitCode: 0 }
    })
    const result = await engine({
      spec: spec([{ id: 'a', max_retries: 0 }, { id: 'b', max_retries: 0 }]),
      adapter,
    }).run()

    expect(result.status).toBe('failed')
    expect(result.keptBranches).toHaveLength(1)
    const kept = result.keptBranches![0]
    expect(kept.taskId).toBe('b')
    // The work is still there, on the kept branch.
    expect(git('show', `${kept.branch}:b-only.txt`)).toBe('b')
    const store = createConvoyStore(join(repo, '.opencastle', 'convoy.db'))
    const types = store.getEvents(result.convoyId).map((e) => e.type)
    store.close()
    expect(types).toContain('merge_conflict_detected')
    expect(types).toContain('merge_failed')
  })
})

describe('resume', () => {
  function seedOldRun(convoyId: string, statuses: Record<string, string>, deps: Record<string, string[]> = {}): void {
    mkdirSync(join(repo, '.opencastle'), { recursive: true })
    const store = createConvoyStore(join(repo, '.opencastle', 'convoy.db'))
    // The old engine recorded the user's own branch here even when the spec named none.
    store.insertConvoy({
      id: convoyId, name: 'Old Run', spec_hash: 'x', status: 'failed', branch: 'main',
      created_at: new Date().toISOString(), spec_yaml: 'name: old',
    })
    for (const [id, status] of Object.entries(statuses)) {
      store.insertTask({
        id, convoy_id: convoyId, phase: deps[id] ? 1 : 0, prompt: `Do ${id}`, agent: 'developer', adapter: null,
        model: null, timeout_ms: 30_000, status: status as never, retries: 1, max_retries: 1,
        files: JSON.stringify([`${id}.txt`]), depends_on: deps[id] ? JSON.stringify(deps[id]) : null, gates: null,
      })
    }
    store.close()
  }

  it('continues a run recorded without a branch of its own, and re-runs the dependents a failure skipped', async () => {
    // Old engine: resume crashed with "'main' is already used by worktree",
    // and retry never reset the skipped dependent, then reported done.
    seedOldRun('convoy-old', { a: 'failed', b: 'skipped' }, { b: ['a'] })
    const adapter = stubAdapter(writesOwnFile)
    const result = await engine({
      spec: spec([{ id: 'a', files: ['a.txt'] }, { id: 'b', files: ['b.txt'], depends_on: ['a'] }]),
      adapter,
    }).resume('convoy-old')

    expect(result.status).toBe('done')
    expect(adapter.execute.mock.calls.map(([t]) => (t as Task).id)).toEqual(['a', 'b'])
    expect(result.branch).toBe(defaultBranchName('Old Run', 'convoy-old'))
    expect(filesOn(result.branch!)).toEqual(['.gitignore', 'README.md', 'a.txt', 'b.txt'])
    expect(git('status', '--porcelain')).toBe('')
    const store = createConvoyStore(join(repo, '.opencastle', 'convoy.db'))
    const convoy = store.getConvoy('convoy-old')!
    const tasks = store.getTasksByConvoy('convoy-old')
    store.close()
    expect(convoy.branch).toBe(result.branch)
    expect(convoy.base_ref).toBe('main')
    // A failed task got its retry budget back.
    expect(tasks.find((t) => t.id === 'a')!.retries).toBe(0)
  })

  it('takes over at once after a run that was killed: dead lock, stale worktree, running task', async () => {
    const convoyId = 'convoy-killed'
    const branch = 'convoy/killed-abc123'
    git('branch', branch)
    // The killed run's integration worktree is still registered and holds the branch.
    await ensureRootWorktree({ repoRoot: repo, branch, base: 'main', dirName: 'killed' })
    const store = createConvoyStore(join(repo, '.opencastle', 'convoy.db'))
    store.insertConvoy({ id: convoyId, name: 'Killed', spec_hash: 'x', status: 'running', branch, base_ref: 'main', created_at: new Date().toISOString(), spec_yaml: 'name: k' })
    store.insertTask({ id: 'a', convoy_id: convoyId, phase: 0, prompt: 'Do a', agent: 'developer', adapter: null, model: null, timeout_ms: 30_000, status: 'running', retries: 0, max_retries: 0, files: JSON.stringify(['a.txt']), depends_on: null, gates: null })
    store.close()
    // The dead process's lock, with a heartbeat one second old.
    const db = new DatabaseSync(join(repo, '.opencastle', 'convoy.db'))
    const now = new Date().toISOString()
    db.prepare('INSERT OR REPLACE INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)').run(999_999, hostname(), now, now)
    db.close()

    const result = await engine({ spec: spec([{ id: 'a', files: ['a.txt'] }]), adapter: stubAdapter(writesOwnFile) }).resume(convoyId)

    expect(result.status).toBe('done')
    expect(result.branch).toBe(branch)
    expect(filesOn(branch)).toContain('a.txt')
    expect((await listAllWorktrees(repo)).map((w) => w.path)).toEqual([repo])
  })
})

describe('interrupting a run', () => {
  it('kills running agents, requeues their tasks, releases the lock and resolves with 130', async () => {
    const controller = new AbortController()
    const adapter = stubAdapter(async (task, options) => {
      if (task.id === 'slow') {
        // Stays "running" until killed.
        await new Promise((r) => setTimeout(r, 2_000))
        return { success: false, output: 'killed', exitCode: 143 }
      }
      writeFileSync(join(options.cwd!, `${task.id}.txt`), 'x\n')
      return { success: true, output: 'done', exitCode: 0 }
    })
    const tasks = [
      { id: 'quick', files: ['quick.txt'] },
      { id: 'slow', files: ['slow.txt'] },
      { id: 'later', files: ['later.txt'], depends_on: ['slow'] },
    ]
    const run = engine({
      spec: spec(tasks, { concurrency: 2 }),
      adapter,
      signal: controller.signal,
    }).run()
    // Interrupt once `quick` has merged and `slow` is still running.
    const dbFile = join(repo, '.opencastle', 'convoy.db')
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 50))
      try {
        const db = new DatabaseSync(dbFile, { readOnly: true })
        const row = db.prepare("SELECT status FROM task WHERE id = 'quick'").get() as { status: string } | undefined
        db.close()
        if (row?.status === 'done') break
      } catch { /* not created yet */ }
    }
    controller.abort()
    const result = await run

    expect(result.status).toBe('interrupted')
    expect(result.exitCode).toBe(130)
    expect(adapter.kill).toHaveBeenCalledWith(expect.objectContaining({ id: 'slow' }))
    const store = createConvoyStore(join(repo, '.opencastle', 'convoy.db'))
    const byId = Object.fromEntries(store.getTasksByConvoy(result.convoyId).map((t) => [t.id, t.status]))
    const convoy = store.getConvoy(result.convoyId)!
    store.close()
    expect(convoy.status).toBe('interrupted')
    expect(byId.quick).toBe('done')
    expect(byId.slow).toBe('pending')
    expect(byId.later).toBe('pending')

    // The lock is free and the run carries on where it stopped.
    const again = stubAdapter(writesOwnFile)
    const resumed = await engine({ spec: spec(tasks), adapter: again }).resume(result.convoyId)
    expect(again.execute.mock.calls.map(([t]) => (t as Task).id)).toEqual(['slow', 'later'])
    expect(resumed.status).toBe('done')
    expect(filesOn(resumed.branch!)).toEqual(['.gitignore', 'README.md', 'later.txt', 'quick.txt', 'slow.txt'])
  })
})

describe('gates that run once', () => {
  it('runs npm test once after all tasks, not once per task', async () => {
    const counter = join(repo, '..', `${repo.split('/').pop()}-count.txt`)
    writeFileSync(join(repo, 'package.json'), JSON.stringify({
      name: 'p', version: '1.0.0', private: true,
      scripts: { test: `node -e "require('fs').appendFileSync('${counter}', 'x')"` },
    }))
    git('add', '-A')
    git('commit', '-qm', 'package')
    try {
      const tasks = [{ id: 'a', files: ['a.txt'] }, { id: 'b', files: ['b.txt'] }, { id: 'c', files: ['c.txt'] }]
      const result = await engine({
        spec: spec(tasks, { defaults: { review: 'none', built_in_gates: { regression_test: true } } }),
        adapter: stubAdapter(writesOwnFile),
      }).run()
      expect(result.status).toBe('done')
      expect(readFileSync(counter, 'utf8')).toBe('x')
      expect(result.gateResults).toEqual([{ command: 'npm test', exitCode: 0, passed: true }])
    } finally {
      rmSync(counter, { force: true })
    }
  }, 30_000)

  it('runs the spec gates on the merged result and commits a gate fix on the branch', async () => {
    const adapter = stubAdapter((task, options) => {
      if (task.id === 'gate-fix-1') writeFileSync(join(options.cwd!, 'fixed.txt'), 'ok\n')
      else writeFileSync(join(options.cwd!, `${task.id}.txt`), 'x\n')
      return { success: true, output: 'done', exitCode: 0 }
    })
    const result = await engine({
      spec: spec([{ id: 'a', files: ['a.txt'] }], { gates: ['node -e "process.exit(require(\'fs\').existsSync(\'fixed.txt\') ? 0 : 1)"'], gate_retries: 1 }),
      adapter,
    }).run()
    expect(result.status).toBe('done')
    expect(filesOn(result.branch!)).toContain('fixed.txt')
    expect(adapter.execute.mock.calls.at(-1)![1]).toMatchObject({ cwd: expect.stringContaining(join('.opencastle', 'worktrees')) })
  }, 30_000)
})

describe('prompts', () => {
  it('start with the same shared context for every task, so a prompt cache can serve it', async () => {
    const prompts: string[] = []
    const adapter = stubAdapter((task, options) => {
      prompts.push(task.prompt)
      return writesOwnFile(task, options)
    })
    await engine({ spec: spec([{ id: 'a', files: ['a.txt'] }, { id: 'b', files: ['b.txt'], depends_on: ['a'] }]), adapter }).run()
    const shared = prompts.map((p) => p.slice(0, p.indexOf('## Your task:')))
    expect(shared[0].length).toBeGreaterThan(100)
    expect(shared[1]).toBe(shared[0])
    expect(prompts[0].match(/Change only the files/g)).toHaveLength(1)
    expect(prompts[0]).not.toContain('.github/instructions')
    expect(prompts[0]).not.toContain('Objective')
  })
})

describe('kept branches', () => {
  it.skipIf(process.platform === 'win32')('fails a task whose merge is refused for any reason, and keeps its work on its branch', async () => {
    // A pre-merge-commit hook refuses every merge commit. The first task's
    // merge is a fast-forward and needs none; the second, cut from the same
    // base, does — and is refused.
    const hookDir = join(repo, '.git', 'hooks')
    mkdirSync(hookDir, { recursive: true })
    writeFileSync(join(hookDir, 'pre-merge-commit'), '#!/bin/sh\necho "merges are frozen" >&2\nexit 1\n', { mode: 0o755 })
    const adapter = stubAdapter(async (task, options) => {
      if (task.id === 'second') await new Promise((r) => setTimeout(r, 80))
      writeFileSync(join(options.cwd!, `${task.id}.txt`), `${task.id}\n`)
      return { success: true, output: 'done', exitCode: 0 }
    })
    const result = await engine({
      spec: spec([{ id: 'first', files: ['first.txt'] }, { id: 'second', files: ['second.txt'] }], { concurrency: 2 }),
      adapter,
    }).run()

    expect(result.status).toBe('failed')
    const kept = result.keptBranches?.find((k) => k.taskId === 'second')
    expect(kept).toBeDefined()
    expect(git('show', `${kept!.branch}:second.txt`)).toBe('second')
    expect(filesOn(result.branch!)).toContain('first.txt')
    expect(filesOn(result.branch!)).not.toContain('second.txt')
    const store = createConvoyStore(join(repo, '.opencastle', 'convoy.db'))
    const task = store.getTask('second', result.convoyId)!
    store.close()
    expect(task.output).toContain('merges are frozen')
    expect(task.output).toContain(kept!.branch)
  })
})
