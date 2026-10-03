import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import log, { LOG_RECORDS, parseLogArgs } from './log.js'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const README = join(repoRoot, 'src', 'orchestrator', 'customizations', 'logs', 'README.md')
const SKILL = join(repoRoot, 'src', 'orchestrator', 'skills', 'observability-logging', 'SKILL.md')

/** The `opencastle log …` command lines in a document's sh blocks, continuation lines joined. */
function examples(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  const out: string[] = []
  for (const block of text.matchAll(/```sh\n([\s\S]*?)```/g)) {
    const joined = block[1].replace(/\\\n\s*/g, ' ')
    for (const line of joined.split('\n')) if (line.trim().startsWith('opencastle log')) out.push(line.trim())
  }
  return out
}

/** Split a shell line into words, as a POSIX shell would for these examples: double quotes and $MODEL. */
function words(line: string, model: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push((m[1] ?? m[2]).replace(/\$MODEL/g, model))
  return out.slice(2) // drop "opencastle log"
}

/** The same line with `--model "$MODEL"` (or `--reviewer_model`) left out, as the README says to when none was reported. */
function withoutModel(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '--reviewer_model') { i++; continue }
    out.push(args[i])
  }
  return out
}

function errorsOf(args: string[]): string[] {
  const parsed = parseLogArgs(args)
  return parsed.ok ? [] : parsed.errors
}

function recordOf(args: string[]): Record<string, unknown> {
  const parsed = parseLogArgs(args)
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  if (parsed.help) throw new Error('help')
  return parsed.record
}

const SESSION = ['--type', 'session', '--agent', 'Developer', '--task', 'Fix it', '--outcome', 'success']

describe('the documented examples', () => {
  const documented = [...examples(README), ...examples(SKILL)]

  it('finds every record type in the README', () => {
    const types = examples(README).map((l) => /--type[= ](\w+)/.exec(l)?.[1])
    expect(types.sort()).toEqual(Object.keys(LOG_RECORDS).sort())
  })

  it.each(documented)('accepts %s', (line) => {
    expect(errorsOf(words(line, 'some-model'))).toEqual([])
    expect(errorsOf(withoutModel(words(line, 'some-model')))).toEqual([])
  })

  it('refuses the examples when $MODEL is empty, as the README warns', () => {
    const line = examples(README).find((l) => l.includes('--model'))!
    expect(errorsOf(words(line, ''))).toEqual(['--model cannot be empty. Leave it out instead when there is nothing to record.'])
  })
})

describe('the schema is the README schema', () => {
  const text = readFileSync(README, 'utf8')
  const KIND_TYPE = { text: 'string', count: 'number', number: 'number', boolean: 'boolean', list: 'string[]' }

  it.each(Object.keys(LOG_RECORDS))('%s record: same fields, required flags, types and allowed values', (type) => {
    const at = text.indexOf(`(\`type: "${type}"\`)`)
    expect(at, `README section for ${type}`).toBeGreaterThan(-1)
    const section = text.slice(at, text.indexOf('\n## ', at + 1) === -1 ? undefined : text.indexOf('\n## ', at + 1))
    const rows = [...section.matchAll(/^\| `(\w+)` \| `([^`]+)` \| (Yes|No[^|]*) \| ([^\n]*)\|$/gm)]
      .filter((m) => m[1] !== 'type' && m[1] !== 'timestamp')
    const schema = LOG_RECORDS[type]
    expect(rows.map((m) => m[1]).sort()).toEqual(Object.keys(schema).sort())
    for (const [, field, docType, required, description] of rows) {
      const f = schema[field]
      expect(f.required, `${type}.${field} required`).toBe(required === 'Yes')
      expect(KIND_TYPE[f.kind], `${type}.${field} type`).toBe(docType)
      if (f.values) {
        const documentedValues = [...description.matchAll(/`([^`]+)`/g)].map((m) => m[1])
        expect([...f.values].sort(), `${type}.${field} values`).toEqual(documentedValues.sort())
      }
    }
  })
})

describe('what it refuses', () => {
  it('a record with none of its required fields', () => {
    expect(errorsOf(['--type', 'session'])).toEqual([
      '--agent is required.',
      '--task is required.',
      '--outcome is required: one of success, partial, failed.',
    ])
  })

  it('values outside an enum', () => {
    expect(errorsOf([...SESSION.slice(0, -1), 'banana'])).toEqual(['--outcome must be one of success, partial, failed, not "banana".'])
    const review = ['--type', 'review', '--agent', 'D', '--verdict', 'maybe', '--attempt', '1', '--issues_critical', '0',
      '--issues_major', '0', '--issues_minor', '0', '--confidence', 'high', '--escalated', 'false']
    expect(errorsOf(review)).toEqual(['--verdict must be one of pass, fail, not "maybe".'])
    const delegation = ['--type', 'delegation', '--session_id', 's', '--agent', 'D', '--tier', 'utility',
      '--mechanism', 'sub-agent', '--outcome', 'success']
    expect(errorsOf(delegation)).toEqual(['--tier must be one of premium, standard, economy, not "utility".'])
  })

  it('a timestamp from the caller', () => {
    expect(errorsOf([...SESSION, '--timestamp', 'yesterday'])).toEqual([
      '--timestamp is not accepted: opencastle log sets the timestamp itself.',
    ])
  })

  it('a flag with no value, instead of storing true', () => {
    expect(errorsOf([...SESSION, '--model'])).toEqual(['--model needs a value.'])
    expect(errorsOf(['--type', 'session', '--model', '--agent', 'D', '--task', 't', '--outcome', 'success'])).toEqual(['--model needs a value.'])
    const panel = ['--type', 'panel', '--panel_key', 'k', '--verdict', 'pass', '--pass_count', '3', '--block_count', '0',
      '--must_fix', '0', '--should_fix', '0', '--attempt', '1', '--weighted']
    expect(errorsOf(panel)).toEqual(['--weighted needs a value.'])
  })

  it('an unknown flag, naming the nearest known one', () => {
    expect(errorsOf([...SESSION, '--agnet', 'x'])).toEqual(['Unknown option --agnet for a session record. Did you mean --agent?'])
    expect(errorsOf([...SESSION, '--dryRun'])).toEqual(['Unknown option --dryRun for a session record. Did you mean --dry-run?'])
    // A field of another record type is unknown here.
    expect(errorsOf([...SESSION, '--verdict', 'pass'])[0]).toMatch(/^Unknown option --verdict for a session record/)
    expect(errorsOf([...SESSION, '--__proto__', 'x'])[0]).toMatch(/^Unknown option --__proto__/)
  })

  it('an unknown or missing type', () => {
    expect(errorsOf(['--type', 'sesion'])[0]).toBe('--type "sesion" is not a record type: one of session, delegation, review, panel, dispute. Did you mean session?')
    expect(errorsOf(['--agent', 'D'])[0]).toBe('--type is required: one of session, delegation, review, panel, dispute.')
  })

  it('numbers that are not numbers, and counts that are not counts', () => {
    expect(errorsOf([...SESSION, '--duration_min', 'twelve'])).toEqual(['--duration_min must be a number, 0 or more, not "twelve".'])
    expect(errorsOf([...SESSION, '--files_changed', '-1'])).toEqual(['--files_changed must be a whole number, 0 or more, not "-1".'])
    expect(errorsOf([...SESSION, '--files_changed', '2.5'])).toEqual(['--files_changed must be a whole number, 0 or more, not "2.5".'])
  })

  it('a boolean that is not true or false', () => {
    const review = ['--type', 'review', '--agent', 'D', '--verdict', 'pass', '--attempt', '0', '--issues_critical', '0',
      '--issues_major', '0', '--issues_minor', '0', '--confidence', 'high', '--escalated', 'yes']
    expect(errorsOf(review)).toEqual([
      '--attempt must be a whole number, at least 1, not "0".',
      '--escalated must be true or false, not "yes".',
    ])
  })

  it('a stray word, the sign of an unquoted value', () => {
    expect(errorsOf(['--type', 'session', '--agent', 'D', '--task', 'Fix', 'bug', '--outcome', 'success'])).toEqual([
      'Unexpected "bug". Every value follows its --field; quote values that contain spaces.',
    ])
  })

  it('the same field twice', () => {
    expect(errorsOf([...SESSION, '--agent', 'Other'])).toEqual(['--agent is given twice.'])
  })
})

describe('what it records', () => {
  it('keeps ids and text as typed: no numeric coercion', () => {
    const rec = recordOf(['--type', 'delegation', '--session_id', '2024', '--agent', 'D', '--tier', 'standard',
      '--mechanism', 'sub-agent', '--outcome', 'success', '--tracker_issue', '007'])
    expect(rec.session_id).toBe('2024')
    expect(rec.tracker_issue).toBe('007')
    expect(recordOf([...SESSION.slice(0, 4), '--task', '007', '--outcome', 'success']).task).toBe('007')
  })

  it('converts numbers, booleans and lists by field', () => {
    const rec = recordOf(['--type', 'dispute', '--dispute_id', 'DSP-1', '--priority', 'high', '--trigger', 'panel-3x-block',
      '--implementing_agent', 'Developer', '--reviewing_agents', 'Reviewer, Panel (3x)', '--total_attempts', '6', '--status', 'pending'])
    expect(rec.reviewing_agents).toEqual(['Reviewer', 'Panel (3x)'])
    expect(rec.total_attempts).toBe(6)
    const review = recordOf(['--type', 'review', '--agent', 'D', '--verdict', 'pass', '--attempt', '1', '--issues_critical', '0',
      '--issues_major', '0', '--issues_minor', '2', '--confidence', 'high', '--escalated', 'false', '--duration_sec', '4.5'])
    expect(review).toMatchObject({ escalated: false, issues_minor: 2, duration_sec: 4.5 })
  })

  it('sets the timestamp itself, first after the type', () => {
    const now = new Date('2026-10-03T07:49:09.383Z')
    const parsed = parseLogArgs(SESSION, now)
    expect(parsed.ok && !parsed.help && Object.entries(parsed.record).slice(0, 2)).toEqual([
      ['type', 'session'],
      ['timestamp', '2026-10-03T07:49:09.383Z'],
    ])
  })

  it('treats --help anywhere as a request for help', () => {
    expect(parseLogArgs(['--type', 'session', '--help'])).toEqual({ ok: true, help: true })
  })
})

describe('the command', () => {
  let dir: string | undefined
  afterEach(() => {
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('appends one valid line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'log-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await log({ pkgRoot: repoRoot, args: [...SESSION, '--logs-dir', dir] })
    await log({ pkgRoot: repoRoot, args: [...SESSION, '--logs-dir', dir, '--duration_min', '3'] })
    const lines = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({ type: 'session', agent: 'Developer', duration_min: 3 })
  })

  it('writes nothing and exits 1 for a record it refuses', async () => {
    dir = mkdtempSync(join(tmpdir(), 'log-'))
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: string) => { errors.push(m) })
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
    await expect(log({ pkgRoot: repoRoot, args: ['--type', 'session', '--logs-dir', dir] })).rejects.toThrow('exit 1')
    expect(errors[0]).toBe('  ✗ opencastle log refused a session record:')
    expect(() => readFileSync(join(dir!, 'events.ndjson'))).toThrow()
  })
})
