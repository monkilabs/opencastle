import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as yamlParse } from 'yaml'

/**
 * Finding a credential in text before it is written somewhere it is committed
 * or logged.
 *
 * The convoy engine scans every event and artefact it writes with this; lessons
 * are scanned before they are written, because a lesson is committed with the
 * project. It lives outside the engine so the compiler's own commands can use
 * it without depending on the experimental engine.
 */

// ── Secret patterns ───────────────────────────────────────────────────────────

interface SecretPatternEntry {
  name: string
  pattern: RegExp
}

const SECRET_PATTERNS: SecretPatternEntry[] = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/i },
  {
    name: 'AWS Secret Key',
    // eslint-disable-next-line no-useless-escape
    pattern: /(?:aws_secret_access_key|secret_key)\s*[=:]\s*[A-Za-z0-9\/+=]{40}/i,
  },
  {
    name: 'Generic API Key',
    pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"]?[A-Za-z0-9_-]{20,}/i,
  },
  { name: 'Bearer Token', pattern: /[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/ },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----/ },
  {
    name: 'Connection String',
    // eslint-disable-next-line no-useless-escape
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s]+:[^\s]+@/,
  },
  { name: 'GitHub Token', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/ },
  {
    name: 'Generic Password',
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{8,}/i,
  },
  { name: 'Slack Token', pattern: /xox[bprs]-[A-Za-z0-9-]{10,}/i },
  {
    name: 'Generic Secret',
    pattern: /(?:secret|token|credential)\s*[=:]\s*['"]?[A-Za-z0-9_-]{16,}/i,
  },
]

// ── Public types ──────────────────────────────────────────────────────────────

export interface SecretScanResult {
  clean: boolean
  findings: Array<{ pattern: string; file: string; line: number; snippet: string }>
}

// ── Allowlist ─────────────────────────────────────────────────────────────────

interface AllowlistEntry {
  pattern?: string
  literal?: string
  reason: string
  paths?: string[]
}

let _allowlist: AllowlistEntry[] | null = null

/** The config path used for the allowlist. Override for testing. */
export let _allowlistConfigPath = join(process.cwd(), '.opencastle', 'secret-scan-config.yml')

/** Reset the allowlist cache (for testing). */
export function _resetAllowlistCache(): void {
  _allowlist = null
}

/** Override the allowlist config path and reset cache (for testing). */
export function _setAllowlistConfigPath(path: string): void {
  _allowlistConfigPath = path
  _allowlist = null
}

function loadAllowlist(): AllowlistEntry[] {
  if (_allowlist !== null) return _allowlist
  try {
    if (!existsSync(_allowlistConfigPath)) {
      _allowlist = []
      return _allowlist
    }
    const content = readFileSync(_allowlistConfigPath, 'utf-8')
    const parsed = yamlParse(content) as Record<string, unknown> | null
    if (!parsed || !Array.isArray(parsed['allowlist'])) {
      _allowlist = []
      return _allowlist
    }
    _allowlist = parsed['allowlist'] as AllowlistEntry[]
    return _allowlist
  } catch {
    _allowlist = []
    return _allowlist
  }
}

function isSuppressed(
  finding: { snippet: string },
  filePath: string,
  allowlist: AllowlistEntry[],
): boolean {
  for (const entry of allowlist) {
    if (entry.paths && entry.paths.length > 0) {
      if (!entry.paths.some((p) => filePath.includes(p))) continue
    }
    if (entry.literal) {
      if (finding.snippet.includes(entry.literal)) return true
    } else if (entry.pattern) {
      try {
        if (new RegExp(entry.pattern, 'i').test(finding.snippet)) return true
      } catch {
        // Invalid regex in allowlist — skip entry
      }
    }
  }
  return false
}

// ── scanForSecrets ────────────────────────────────────────────────────────────

/**
 * Scan text content line-by-line for secrets using the default pattern set.
 * Allowlist entries in `.opencastle/secret-scan-config.yml` suppress false positives.
 */
export function scanForSecrets(content: string, filePath = ''): SecretScanResult {
  const allowlist = loadAllowlist()
  const lines = content.split('\n')
  const findings: SecretScanResult['findings'] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        const snippet = line.length > 100 ? line.slice(0, 97) + '...' : line
        const finding = { pattern: name, file: filePath, line: i + 1, snippet }
        if (!isSuppressed(finding, filePath, allowlist)) {
          findings.push(finding)
        }
        // Only report the first matching pattern per line
        break
      }
    }
  }

  return { clean: findings.length === 0, findings }
}
