import { parse as parseToml } from 'smol-toml'

/**
 * Reading and writing an MCP config file in whatever language it is written in.
 *
 * Every target but one keeps its servers in JSON. Codex CLI keeps them in
 * `.codex/config.toml`, beside the rest of the project's Codex settings, and
 * OpenCastle wrote `.codex/mcp.json` — a file Codex has never read — so no
 * integration or team server reached Codex at all. The merge, strip, audit and
 * drift logic all work on a parsed object; this is the one place that knows a
 * config can be TOML, so none of them has to.
 *
 * `config.toml` is co-owned the way `opencode.json` is: the user's model,
 * approval and sandbox settings sit beside our servers. Re-serialising it whole
 * would restyle it and drop every comment, so a TOML write changes only the
 * `[mcp_servers.<name>]` tables whose value changed and leaves every other byte
 * as it was.
 */

/** Thrown when a TOML config is shaped so that a change cannot be made without rewriting the user's text. */
export class TomlEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TomlEditError'
  }
}

export function isTomlConfig(rel: string): boolean {
  return rel.endsWith('.toml')
}

/** Parse a config's text. Throws, as `JSON.parse` does, when it does not parse. */
export function parseMcpConfigText(text: string, rel: string): Record<string, unknown> {
  if (isTomlConfig(rel)) return plain(parseToml(text)) as Record<string, unknown>
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * The text to write for `value`, given what the file held before (`null` when
 * it is being created).
 */
export function serialiseMcpConfig(before: string | null, value: Record<string, unknown>, rel: string): string {
  if (isTomlConfig(rel)) return writeToml(before ?? '', value)
  return before === null ? JSON.stringify(value, null, 2) + '\n' : serialiseLike(before, value)
}

// ── JSON ──────────────────────────────────────────────────────

/**
 * The indentation a file already uses, so merging into it does not restyle it.
 *
 * `JSON.stringify(x, null, 2)` re-indented every co-owned config we touched. A
 * hand-written tab-indented `opencode.json` — OpenCode's entire project config —
 * came back two-space indented from a merge that added one key, and never came back
 * from the uninstall at all: 111 bytes in, 114 out, for a strip that took nothing
 * of theirs. Byte fidelity is a claim this tool makes about co-owned files, and a
 * JSON config is one of those.
 *
 * Read from the first indented line, which is what every formatter agrees on.
 * Falls back to two spaces for a file we are creating or one written on a single
 * line, which is what this always did.
 */
function indentOf(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text)
  if (m) return m[1].includes('\t') ? '\t' : m[1].length
  // A config written on one line has no indentation, and expanding it to three is
  // as much a restyle as collapsing it would be. `0` is what `JSON.stringify` takes
  // for "no whitespace".
  return text.trim().includes('\n') ? 2 : 0
}

/**
 * Re-serialise a config the way the file was already written.
 *
 * Indentation and line endings both, because `JSON.stringify` emits `\n` whatever
 * it was handed and a CRLF config came back LF from a merge that added one key.
 * The same rule `.gitignore` follows: a CRLF file stays CRLF.
 */
export function serialiseLike(original: string, value: unknown): string {
  const text = JSON.stringify(value, null, indentOf(original)) + '\n'
  return /\r\n/.test(original) ? text.replace(/\n/g, '\r\n') : text
}

// ── TOML ──────────────────────────────────────────────────────

const SERVERS = 'mcp_servers'

/** smol-toml builds objects with no prototype; the rest of the code expects plain ones. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

/** Key order is not meaning. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

/**
 * A TOML basic string. JSON's escapes are TOML's, except that TOML also forbids
 * a raw DEL, which JSON leaves alone.
 */
function tomlString(s: string): string {
  return JSON.stringify(s).replace(/\u007f/g, '\\u007F')
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (value && typeof value === 'object') {
    const fields = Object.entries(value).filter(([, v]) => v !== undefined)
    return fields.length === 0 ? '{}' : `{ ${fields.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(', ')} }`
  }
  throw new TomlEditError(`cannot write ${String(value)} as TOML`)
}

/** One server as a `[mcp_servers.<key>]` table. */
function serverTable(key: string, entry: unknown, eol: string): string {
  const lines = [`[${SERVERS}.${tomlKey(key)}]`]
  for (const [k, v] of Object.entries((entry ?? {}) as Record<string, unknown>)) {
    if (v === undefined) continue
    lines.push(`${tomlKey(k)} = ${tomlValue(v)}`)
  }
  return lines.join(eol) + eol
}

interface Segment {
  /** The table this run of lines belongs to, as its dotted key; `null` before the first header. */
  path: string[] | null
  lines: string[]
}

const HEADER = /^[ \t]*\[\[?[ \t]*(.+?)[ \t]*\]\]?[ \t]*(?:#.*)?\r?\n?$/

/** Split a dotted key into its parts, unquoting quoted ones. */
function splitKey(key: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]
    if (quote) {
      if (ch === '\\' && quote === '"') {
        current += key[++i] ?? ''
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '.') {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current.trim())
  return parts
}

/**
 * The file as runs of lines, one per table.
 *
 * A line that looks like a header inside a multi-line string is not one; the
 * string delimiters are tracked so it stays with the table it belongs to. Odd
 * layouts this misreads are caught afterwards: every write is parsed back and
 * compared with what was meant.
 */
function segments(text: string): Segment[] {
  const lines = text.split(/(?<=\n)/)
  const out: Segment[] = [{ path: null, lines: [] }]
  let open: '"""' | "'''" | null = null
  for (const line of lines) {
    if (!open) {
      const header = HEADER.exec(line)
      if (header && !line.trimStart().startsWith('#')) {
        out.push({ path: splitKey(header[1]), lines: [line] })
        continue
      }
    }
    out[out.length - 1].lines.push(line)
    for (const m of line.matchAll(/"""|'''/g)) {
      if (!open) open = m[0] as '"""' | "'''"
      else if (open === m[0]) open = null
    }
  }
  return out
}

/** The blank and comment lines a segment ends with — they introduce whatever follows it. */
function tailOf(seg: Segment): string[] {
  const tail: string[] = []
  for (let i = seg.lines.length - 1; i > 0; i--) {
    const t = seg.lines[i].trim()
    if (t === '' || t.startsWith('#')) tail.unshift(seg.lines[i])
    else break
  }
  return tail
}

function serverOf(seg: Segment): string | undefined {
  return seg.path && seg.path[0] === SERVERS && seg.path.length >= 2 ? seg.path[1] : undefined
}

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _drop, ...rest } = value
  return rest
}

/** An empty `[mcp_servers]` and none at all say the same thing to Codex. */
function normalised(value: unknown): unknown {
  const v = value as Record<string, unknown>
  const servers = v[SERVERS]
  return servers && typeof servers === 'object' && Object.keys(servers).length === 0 ? without(v, SERVERS) : v
}

/**
 * Write `value` over `before`, touching only the server tables that changed.
 *
 * Everything outside `[mcp_servers]` must be what the file already says —
 * OpenCastle never edits a user's Codex settings — and the result is parsed
 * back before it is returned, so a layout this cannot edit cleanly is refused
 * rather than written wrong.
 */
function writeToml(before: string, value: Record<string, unknown>): string {
  const eol = /\r\n/.test(before) ? '\r\n' : '\n'
  const old = (before.trim() === '' ? {} : plain(parseToml(before))) as Record<string, unknown>
  if (canonical(without(old, SERVERS)) !== canonical(without(value, SERVERS))) {
    throw new TomlEditError('only the [mcp_servers] tables of a Codex config are ours to change')
  }
  const oldServers = (old[SERVERS] ?? {}) as Record<string, unknown>
  const newServers = (value[SERVERS] ?? {}) as Record<string, unknown>

  const out: string[] = []
  const rewritten = new Set<string>()
  // Whether the file now ends where a dropped table used to be. The blank line
  // that separated our first table from the user's last one was ours, written
  // when we appended; left behind, an install and uninstall would not give the
  // user back their file byte for byte.
  let endsOnDrop = false
  for (const seg of segments(before)) {
    const key = serverOf(seg)
    if (key === undefined) {
      out.push(...seg.lines)
      endsOnDrop = false
      continue
    }
    const tail = tailOf(seg)
    if (!(key in newServers)) {
      // A comment before the next table is about that table; keep it.
      if (tail.some((l) => l.trim().startsWith('#'))) out.push(...tail)
      endsOnDrop = true
      continue
    }
    endsOnDrop = false
    if (canonical(oldServers[key]) === canonical(newServers[key])) {
      out.push(...seg.lines)
      continue
    }
    // A changed server is written whole at its first table; its sub-tables go.
    if (rewritten.has(key)) {
      if (tail.some((l) => l.trim().startsWith('#'))) out.push(...tail)
      continue
    }
    rewritten.add(key)
    out.push(serverTable(key, newServers[key], eol), ...tail)
  }

  let text = out.join('')
  if (endsOnDrop) text = text.trim() === '' ? '' : text.replace(/(\r?\n)+$/, eol)
  const added = Object.keys(newServers).filter((k) => !(k in oldServers))
  if (added.length > 0) {
    if (text !== '' && !text.endsWith('\n')) text += eol
    if (text.trim() !== '' && !/(\r?\n){2}$/.test(text)) text += eol
    text += added.map((k) => serverTable(k, newServers[k], eol)).join(eol)
  }

  let check: unknown
  try {
    check = plain(parseToml(text))
  } catch (err) {
    throw new TomlEditError(`the edit would not parse — ${(err as Error).message}`)
  }
  if (canonical(normalised(check)) !== canonical(normalised(value))) {
    throw new TomlEditError('its [mcp_servers] are written in a way this cannot edit line by line, e.g. as inline tables')
  }
  return text
}
