/**
 * A flag is refused when the spec's executor will never read it.
 *
 * The defect: `--report-dir` is consumed where `createReporter` is called, which
 * is the legacy path alone. For a `version: 1` spec — what every generated spec
 * is — it was parsed, resolved against cwd, and never handed to the engine,
 * which has no report directory at all. `convoy run -f spec.yml --report-dir
 * ./out` exited 0 with ./out empty. `--watch` and its companions had the mirror
 * problem: they live inside the engine branch, so a legacy or pipeline spec
 * accepted them and ran once.
 */
import { describe, it, expect } from 'vitest'
import { specExecutor } from './run.js'
import type { TaskSpec } from './convoy/spec-types.js'

const base = { name: 'S', concurrency: 1, tasks: [{ id: 't', agent: 'developer' }] }

const spec = (over: Record<string, unknown> = {}): TaskSpec =>
  ({ ...base, ...over }) as unknown as TaskSpec

describe('specExecutor', () => {
  it('sends a version 2 spec with a convoy chain to the pipeline orchestrator', () => {
    expect(specExecutor(spec({ version: 2, depends_on_convoy: ['a.yml'] }))).toBe('pipeline')
  })

  it('sends a version 1 spec to the convoy engine', () => {
    expect(specExecutor(spec({ version: 1 }))).toBe('engine')
  })

  it('sends a spec with no version to the legacy executor', () => {
    expect(specExecutor(spec())).toBe('legacy')
  })

  it('puts a generated spec on the engine, which is why --report-dir mattered', () => {
    // buildConvoyYaml always writes `version: 1`.
    expect(specExecutor(spec({ version: 1, defaults: { timeout: '30m' } }))).toBe('engine')
  })
})
