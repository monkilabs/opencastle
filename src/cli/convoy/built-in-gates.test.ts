import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * Every gate the spec accepts is a gate the engine runs.
 *
 * `dependency_audit` and `regression_test` were declared in the task-spec
 * validator, implemented in full in `gates.ts`, and switched on to `'auto'` by
 * `spec-builder.ts` without anyone asking — and never executed. A user could put
 * `regression_test: true` in a convoy spec, watch it validate, watch the run
 * succeed, and never learn that their test suite was not run. Nothing failed,
 * which is the worst shape a defect can take in a gate.
 *
 * The three lists are derived rather than written down, so the next gate added to
 * the validator is covered here whether or not anyone remembers this file:
 *
 *   accepted  — the field names `validateSpec` allows under `built_in_gates`
 *   built     — the gate functions `gates.ts` exports
 *   executed  — the gate names the engine actually branches on and calls
 *
 * A name in `accepted` that is missing from either of the others is a promise the
 * tool does not keep.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

/** Gate names the spec validator accepts under `built_in_gates`. */
function acceptedGates(): string[] {
  const schema = read('src/cli/run/schema.ts')
  const m = /boolOrAutoFields = \[(.*?)\] as const/s.exec(schema)
  expect(m, 'could not find the built_in_gates field list in run/schema.ts').toBeTruthy()
  const names = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
  expect(names.length, 'the field list parsed as empty').toBeGreaterThan(0)
  return names
}

/**
 * The gate name each exported gate function serves.
 *
 * Matched on the function's own name, since the two conventions in use
 * (`runSecretScanGate`, `browserTestGate`) both encode it.
 */
function builtGates(accepted: string[]): Map<string, string> {
  const gates = read('src/cli/convoy/gates.ts')
  const exported = [...gates.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])
  const found = new Map<string, string>()
  for (const name of accepted) {
    const camel = name
      .split('_')
      .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
      .join('')
    const hit = exported.find(
      (fn) => fn.toLowerCase() === `run${camel}gate`.toLowerCase() || fn.toLowerCase() === `${camel}gate`.toLowerCase(),
    )
    if (hit) found.set(name, hit)
  }
  return found
}

describe('built-in gates the spec accepts are gates that run', () => {
  const accepted = acceptedGates()

  it('parses a non-trivial list of accepted gates', () => {
    expect(accepted.length).toBeGreaterThanOrEqual(5)
  })

  it('implements every accepted gate', () => {
    const built = builtGates(accepted)
    const missing = accepted.filter((g) => !built.has(g))
    expect(missing, `accepted by the validator with no implementation: ${missing.join(', ')}`).toEqual([])
  })

  it('executes every accepted gate from the engine', () => {
    const engine = read('src/cli/convoy/engine.ts')
    const built = builtGates(accepted)
    const inert: string[] = []
    for (const gate of accepted) {
      const fn = built.get(gate)
      if (!fn) continue
      // Branched on, and the implementation actually invoked. Either half alone is
      // how these two came to be accepted, auto-enabled and never run.
      const branched = new RegExp(`builtInGates(?:\\.|\\[')${gate}`).test(engine)
      const invoked = new RegExp(`\\b${fn}\\s*\\(`).test(engine)
      if (!branched || !invoked) inert.push(`${gate} (branched=${branched}, invoked=${invoked})`)
    }
    expect(inert, `accepted by the validator and never executed: ${inert.join('; ')}`).toEqual([])
  })

  it('never auto-enables a gate it does not execute', () => {
    // `spec-builder.ts` turns gates on by itself. Anything it enables has to be a
    // gate that runs, or the tool is silently promising work it will not do.
    const builder = read('src/cli/convoy/spec-builder.ts')
    const engine = read('src/cli/convoy/engine.ts')
    const built = builtGates(accepted)
    const autoEnabled = [...builder.matchAll(/gates\.([a-z_]+)\s*=/g)].map((m) => m[1])
    const broken = autoEnabled.filter((g) => {
      const fn = built.get(g)
      return !fn || !new RegExp(`\\b${fn}\\s*\\(`).test(engine)
    })
    expect(broken, `auto-enabled but not executed: ${broken.join(', ')}`).toEqual([])
  })
})

describe('the gate test file itself is wired up', () => {
  it('can see the sources it reasons about', () => {
    for (const rel of [
      'src/cli/run/schema.ts',
      'src/cli/convoy/gates.ts',
      'src/cli/convoy/engine.ts',
      'src/cli/convoy/spec-builder.ts',
    ]) {
      expect(existsSync(join(repoRoot, rel)), `${rel} not found — the paths have moved`).toBe(true)
    }
  })
})
