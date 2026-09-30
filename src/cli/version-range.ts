/**
 * Just enough semver to answer one question: does the running OpenCastle
 * satisfy the range a team pinned in `.opencastle/config.json`?
 *
 * A team whose members run different OpenCastle versions gets a pull request
 * war: each `sync` rewrites the generated files to its own release's output and
 * the next person's `sync` rewrites them back. The version belongs to the
 * project, like any other tool's, so the project can say which one it wants.
 *
 * Supported: exact (`0.36.0`), `^`, `~`, x-ranges (`0.36.x`, `0.x`, `*`),
 * comparators (`>=0.36.0 <0.38.0`) and `||` alternatives. Prereleases compare
 * by their dotted identifiers. That covers every range npm users write for a
 * CLI; anything else is reported as unparseable rather than guessed at.
 */

type Version = [number, number, number, string[]]

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []]
}

function comparePre(a: string[], b: string[]): number {
  // A release outranks any of its prereleases.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i])
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (an !== bn) {
      return an ? -1 : 1
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1
    }
  }
  return 0
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return comparePre(a[3], b[3])
}

type Comparator = { op: '>=' | '>' | '<=' | '<' | '='; version: Version }

/** `1`, `1.2`, `1.x`, `1.2.*` → the parts given, with wildcards as null. */
function partial(text: string): [number | null, number | null, number | null, string[]] | null {
  const m = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (!m) return null
  const num = (s: string | undefined): number | null =>
    s === undefined || /^[xX*]$/.test(s) ? null : Number(s)
  return [num(m[1]), num(m[2]), num(m[3]), m[4] ? m[4].split('.') : []]
}

function v(major: number, minor: number, patch: number, pre: string[] = []): Version {
  return [major, minor, patch, pre]
}

/** One space-separated term of a range, as comparators. Null when unreadable. */
function term(raw: string): Comparator[] | null {
  if (raw === '*' || raw === 'x' || raw === 'X' || raw === '') return []
  const op = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(raw)
  if (!op) return null
  const sign = op[1] ?? ''
  const p = partial(op[2])
  if (!p) return null
  const [ma, mi, pa, pre] = p
  if (ma === null) return sign === '' || sign === '=' || sign === '>=' ? [] : null

  if (sign === '^') {
    const lo = v(ma, mi ?? 0, pa ?? 0, pre)
    let hi: Version
    if (ma > 0 || mi === null) hi = v(ma + 1, 0, 0, ['0'])
    else if (mi > 0 || pa === null) hi = v(0, mi + 1, 0, ['0'])
    else hi = v(0, 0, pa + 1, ['0'])
    return [{ op: '>=', version: lo }, { op: '<', version: hi }]
  }
  if (sign === '~') {
    const lo = v(ma, mi ?? 0, pa ?? 0, pre)
    const hi = mi === null ? v(ma + 1, 0, 0, ['0']) : v(ma, mi + 1, 0, ['0'])
    return [{ op: '>=', version: lo }, { op: '<', version: hi }]
  }
  if (sign === '' || sign === '=') {
    if (mi === null) return [{ op: '>=', version: v(ma, 0, 0) }, { op: '<', version: v(ma + 1, 0, 0, ['0']) }]
    if (pa === null) return [{ op: '>=', version: v(ma, mi, 0) }, { op: '<', version: v(ma, mi + 1, 0, ['0']) }]
    return [{ op: '=', version: v(ma, mi, pa, pre) }]
  }
  // Comparators with a partial version: `>=1.2` means `>=1.2.0`, `<1.2` means `<1.2.0`,
  // `>1.2` means `>=1.3.0`, `<=1.2` means `<1.3.0`.
  if (sign === '>=' || sign === '<') {
    return [{ op: sign, version: v(ma, mi ?? 0, pa ?? 0, pre) }]
  }
  if (pa !== null && mi !== null) return [{ op: sign as Comparator['op'], version: v(ma, mi, pa, pre) }]
  const next = mi === null ? v(ma + 1, 0, 0) : v(ma, mi + 1, 0)
  return [{ op: sign === '>' ? '>=' : '<', version: next }]
}

function test(version: Version, c: Comparator): boolean {
  const d = compareVersions(version, c.version)
  switch (c.op) {
    case '>=': return d >= 0
    case '>': return d > 0
    case '<=': return d <= 0
    case '<': return d < 0
    case '=': return d === 0
  }
}

/**
 * Does `version` satisfy `range`? `null` when either cannot be read — the
 * caller says so instead of treating an unreadable range as a pass or a fail.
 */
export function satisfies(version: string, range: string): boolean | null {
  const ver = parseVersion(version)
  if (!ver) return null
  let any = false
  for (const alt of range.split('||')) {
    // `1.2.3 - 2.0.0` hyphen ranges.
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt)
    // `>= 1.2.0`, written with a space, is one comparator.
    const joined = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    const parts = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : joined.split(/\s+/)
    const comparators: Comparator[] = []
    for (const part of parts) {
      const t = term(part)
      if (t === null) return null
      comparators.push(...t)
    }
    // A prerelease only satisfies a range that names a prerelease of the same
    // version, as npm has it — `^0.36.0` must not accept `0.37.0-rc.1`.
    if (ver[3].length > 0) {
      const allowed = comparators.some(
        (c) => c.version[3].length > 0 && c.version[0] === ver[0] && c.version[1] === ver[1] && c.version[2] === ver[2],
      )
      if (!allowed) continue
    }
    if (comparators.every((c) => test(ver, c))) any = true
  }
  return any
}
