/**
 * The rules a team's layers hold MCP servers to, in one place for the two
 * readers that apply them: source resolution, which refuses to compile a
 * server the policy forbids, and the audit, which reads what is actually in
 * each target's config — including servers somebody added by hand.
 */

export interface EffectivePolicy {
  /** Every layer's allowlist; a server must be on all of them. */
  allowLists: Array<{ by: string; where: string; patterns: string[] }>
  hostLists: Array<{ by: string; where: string; patterns: string[] }>
  /** The layer that turned it on, if one did. It cannot be turned off above. */
  requirePinned?: string
  require: Array<{ ref: string; by: string }>
  contextBudget?: { tokens: number; by: string }
  versionRanges: Array<{ range: string; by: string; where: string }>
}

export function emptyPolicy(): EffectivePolicy {
  return { allowLists: [], hostLists: [], require: [], versionRanges: [] }
}

/** `*` matches any run of characters; everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return re.test(value)
}

/** `*.acme.dev` matches any subdomain of acme.dev; anything else must match exactly. */
function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1
  return p === h
}

/** The layers whose allowlist refuses a server key, or null when it is allowed. */
export function disallowedBy(policy: EffectivePolicy, key: string): string | null {
  const refusing = policy.allowLists.filter((l) => !l.patterns.some((p) => globMatch(p, key)))
  return refusing.length > 0 ? refusing.map((l) => l.by).join(', ') : null
}

/**
 * A URL's host, and only its host. Messages name this and never the URL: a
 * query string can carry a credential, and printing it to say the host is not
 * allowed would leak it into terminals, CI logs and pull request annotations.
 */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url.replace(/\$\{[^}]*\}|\{env:[^}]*\}/g, 'x')).hostname
  } catch {
    return '(an unreadable URL)'
  }
}

/** Whether one list of host patterns allows a URL. */
export function hostAllowedBy(patterns: string[], url: string): boolean {
  let host: string
  try {
    host = new URL(url.replace(/\$\{[^}]*\}|\{env:[^}]*\}/g, 'x')).hostname
  } catch {
    return false
  }
  return patterns.some((p) => hostMatches(p, host))
}

/** The layers that refuse a remote URL's host, or null when it is allowed. */
export function hostDisallowedBy(policy: EffectivePolicy, url: string): string | null {
  const refusing = policy.hostLists.filter((l) => !hostAllowedBy(l.patterns, url))
  return refusing.length > 0 ? refusing.map((l) => l.by).join(', ') : null
}

// ── Credentials written into a config ──────────────────────────

/**
 * Formats real tokens take. Deliberately specific: a false "you committed a
 * secret" on an ordinary value teaches people to ignore the check.
 */
const TOKEN_FORMATS = new RegExp(
  '^(?:' +
    [
      'sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}',
      'sk_(?:live|test)_[A-Za-z0-9]{16,}',
      'rk_(?:live|test)_[A-Za-z0-9]{16,}',
      'whsec_[A-Za-z0-9]{24,}',
      'gh[pousr]_[A-Za-z0-9]{30,}',
      'github_pat_[A-Za-z0-9_]{30,}',
      'glpat-[A-Za-z0-9_-]{20,}',
      'npm_[A-Za-z0-9]{36}',
      'hf_[A-Za-z0-9]{30,}',
      'sbp_[a-f0-9]{40}',
      'shpat_[a-f0-9]{32}',
      'dop_v1_[a-f0-9]{64}',
      'xox[abeprs]-[A-Za-z0-9-]{10,}',
      'AKIA[0-9A-Z]{16}',
      'lin_(?:api|oauth)_[A-Za-z0-9]{20,}',
      'sntry[su]_[A-Za-z0-9+/=_-]{20,}',
      'figd_[A-Za-z0-9_-]{20,}',
      'ntn_[A-Za-z0-9]{20,}',
      're_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}',
      'AIza[0-9A-Za-z_-]{35}',
      'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    ].join('|') +
    ')',
)

/**
 * Names that say "this value is a credential". `auth` and `key` only as whole
 * words: `OAUTH_CLIENT_ID` is an identifier and `AUTH_MODE` a setting, and
 * flagging them stopped a compile over nothing secret.
 */
const SECRET_NAME = /(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|(^|[_-])auth$|(^|[_-])key$)/i

/** Names that end like a pointer to a secret, not the secret itself. */
const NOT_A_SECRET = /[_-](id|mode|url|uri|file|path|dir|region|name|sha|hash|type|endpoint|host|port|user|username|header|scheme)$/i

/** Keys that are public by design, or not credentials at all. */
const PUBLIC_KEY = /(publishable|public|site|search|idempotency|cache|partition|sort|primary)[_-]?key$/i

const PLACEHOLDER = /^(?:replace[_-]?me|change[_-]?me|your[_-].*|<[^>]*>|x{3,}|\*+|todo|tbd|null|none|true|false|\d{1,6})$/i

/** `${NAME}`, `${env:NAME}`, `{env:NAME}`, `{file:…}` anywhere; `$NAME` only as the whole value. */
function isReference(value: string): boolean {
  return /\$\{[^}]+\}|\{env:[^}]+\}|\{file:[^}]+\}/.test(value) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

/** A value that could be a credential: long, no spaces, letters and digits, not a path or URL. */
function looksRandom(value: string): boolean {
  return (
    value.length >= 16 &&
    !/\s/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !/^(?:https?:|\/|\.|~|[A-Za-z]:\\)/.test(value) &&
    // A relative path to a file — `secrets/token.txt` — not base64, which can
    // hold `/` too: an AWS secret key often does.
    !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}$/.test(value)
  )
}

/** A URL with a password in it: `postgres://user:pass@host/db`. */
function urlWithPassword(value: string): boolean {
  if (isReference(value)) return false
  try {
    const u = new URL(value)
    return Boolean(u.password) && !isReference(decodeURIComponent(u.password))
  } catch {
    return false
  }
}

function isSecretValue(name: string, raw: string): boolean {
  const value = raw.replace(/^(?:Bearer|Basic|Token|token)\s+/, '').trim()
  if (value === '' || isReference(value) || PLACEHOLDER.test(value)) return false
  if (TOKEN_FORMATS.test(value)) return true
  if (urlWithPassword(value)) return true
  // Anything written into an Authorization header is the credential itself.
  if (/^authorization$/i.test(name)) return value.length >= 8
  if (NOT_A_SECRET.test(name) || PUBLIC_KEY.test(name)) return false
  return SECRET_NAME.test(name) && looksRandom(value)
}

/**
 * Where a server entry holds a credential written out in full, or null.
 *
 * Returns the location only (`env.API_KEY`, `headers.Authorization`, `args`,
 * `url`), never the value: this is printed, and printing the secret to say it
 * should not be visible would be its own leak.
 */
export function findInlineSecret(entry: Record<string, unknown>): string | null {
  for (const field of ['env', 'environment', 'headers']) {
    const block = entry[field]
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (typeof value === 'string' && isSecretValue(name, value)) return `${field}.${name}`
    }
  }
  const command = entry.command
  const args: unknown[] = Array.isArray(command)
    ? command.slice(1)
    : Array.isArray(entry.args)
      ? (entry.args as unknown[])
      : []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (typeof arg !== 'string') continue
    const eq = /^--?([A-Za-z0-9_-]+)=(.+)$/.exec(arg)
    if (eq && isSecretValue(eq[1], eq[2])) return 'args'
    const flag = /^--?([A-Za-z0-9_-]+)$/.exec(arg)
    const next = args[i + 1]
    if (flag && SECRET_NAME.test(flag[1]) && typeof next === 'string' && isSecretValue(flag[1], next)) return 'args'
    if (!arg.startsWith('-') && !isReference(arg) && TOKEN_FORMATS.test(arg)) return 'args'
  }
  const url = entry.url ?? entry.serverUrl
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url.replace(/\$\{[^}]*\}|\{env:[^}]*\}/g, 'x'))
      for (const [name, value] of parsed.searchParams) {
        if (isSecretValue(name, value)) return 'url'
      }
      if (parsed.password) return 'url'
    } catch {
      // Not a URL we can read; nothing to say about it.
    }
  }
  return null
}
