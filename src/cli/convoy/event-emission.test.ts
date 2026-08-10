/**
 * Every declared event type is emitted by something.
 *
 * Four types were declared, schema'd, listed in TELEMETRY.md against a source
 * file, offered as a dashboard filter — and emitted by nothing:
 * `weak_area_skipped`, `discovered_issue`, `context_compacted` and
 * `skill_refinement_proposed`. ARCHITECTURE.md described one of them as a
 * shipped feature ("weak-area avoidance skips agents for files they've
 * historically struggled with"), and TELEMETRY.md attributed another to an
 * `issues.ts` that has never existed.
 *
 * The existing test asserted that the registry *contains* each name, which is
 * true of a name that nothing emits — it could not have caught this, and did
 * not, for as long as the four had been there. This asserts the other
 * direction: a name in the registry has to correspond to a call somewhere.
 *
 * Source text, not runtime behaviour. Reaching every emission site by running
 * the engine would need a convoy that fails, disputes, trips a breaker and
 * leaks a secret; the defect being guarded is a declaration with no code behind
 * it anywhere, and that is visible statically.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { KNOWN_EVENT_TYPES } from './types.js'

const SRC = resolve(import.meta.dirname, '..', '..')

/** Every .ts file under src/, excluding tests and the declarations themselves. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    if (entry.endsWith('.test.ts')) continue
    // The files that *declare* the types would match every name trivially.
    if (entry === 'types.ts' || entry === 'event-schemas.ts') continue
    out.push(full)
  }
  return out
}

const corpus = sourceFiles(SRC)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

describe('declared event types', () => {
  it('are each produced somewhere in the product', () => {
    const orphans = [...KNOWN_EVENT_TYPES].filter(
      (type) => !new RegExp(`['"\`]${type}['"\`]`).test(corpus),
    )
    expect(
      orphans,
      `declared but never emitted — implement the emission or drop the declaration:\n  ${orphans.join('\n  ')}`,
    ).toEqual([])
  })

  it('has a registry that is not trivially empty', () => {
    // A guard against the check above passing because the corpus or the
    // registry failed to load.
    expect(KNOWN_EVENT_TYPES.size).toBeGreaterThan(30)
    expect(corpus.length).toBeGreaterThan(10_000)
  })

  it('no longer declares the four that nothing produced', () => {
    for (const dead of [
      'weak_area_skipped',
      'discovered_issue',
      'context_compacted',
      'skill_refinement_proposed',
    ]) {
      expect(KNOWN_EVENT_TYPES.has(dead), `${dead} is back without an emitter`).toBe(false)
    }
  })
})
