import { scanForSecrets } from '../secret-scan.js'

/**
 * Masking credentials before they are stored.
 *
 * The scanner only said *whether* a line held a secret, so every caller chose
 * between writing the secret and dropping the record. Events were inserted into
 * SQLite unscanned and only the NDJSON copy was blocked — the dashboard then
 * served the SQLite copy, and a resume replayed it into the NDJSON file as well.
 * Masking keeps the record and loses only the value.
 */

export const REDACTED = '[REDACTED]'

export interface RedactResult {
  text: string
  /** Pattern names that matched, one per masked line. Empty when nothing was masked. */
  patterns: string[]
}

/**
 * Mask the likely value on a line the scanner flagged.
 *
 * Long or digit-bearing tokens are what credentials look like; ordinary words
 * around them ("password", "token", "Bearer") stay, so the line still says what
 * was there. If the line still matches afterwards, the whole line goes.
 */
export function maskSecretLine(line: string, pattern = 'secret'): string {
  const masked = line.replace(/[A-Za-z0-9_\-+/=.~]{8,}/g, (token) =>
    token.length >= 16 || /\d/.test(token) ? REDACTED : token,
  )
  if (scanForSecrets(masked).clean) return masked
  return `${REDACTED} (${pattern})`
}

/** Mask every line of `text` the scanner flags. */
export function redactSecrets(text: string): RedactResult {
  const scan = scanForSecrets(text)
  if (scan.clean) return { text, patterns: [] }
  const lines = text.split('\n')
  const patterns: string[] = []
  for (const finding of scan.findings) {
    const i = finding.line - 1
    if (lines[i] === undefined) continue
    lines[i] = maskSecretLine(lines[i], finding.pattern)
    patterns.push(finding.pattern)
  }
  return { text: lines.join('\n'), patterns }
}

/**
 * Mask every string inside a JSON-like value. Structure is kept, so an event's
 * fields stay where readers look for them.
 */
export function redactValue<T>(value: T): { value: T; patterns: string[] } {
  const patterns: string[] = []
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v)
      patterns.push(...r.patterns)
      return r.text
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = walk(inner)
      return out
    }
    return v
  }
  const result = walk(value) as T
  return { value: result, patterns }
}
