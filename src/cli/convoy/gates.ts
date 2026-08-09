import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { parse as yamlParse } from 'yaml'
import { filePathFields } from './contracts.js'
import type { BrowserTestConfig, MCPServerConfig } from './types.js'

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

// ── withSecretScan ────────────────────────────────────────────────────────────

/**
 * Guard a write action with a secret scan.
 * Calls `writeAction` if content is clean; calls `onBlock` with findings otherwise.
 */
export function withSecretScan(
  content: string,
  writeAction: () => void,
  onBlock: (findings: SecretScanResult['findings']) => void,
): void {
  const result = scanForSecrets(content)
  if (result.clean) {
    writeAction()
  } else {
    onBlock(result.findings)
  }
}

// ── Gate command runner ───────────────────────────────────────────────────────

export interface GateCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

/**
 * Run a shell command with SIGTERM → SIGKILL timeout escalation.
 * On timeout: sends SIGTERM immediately, then SIGKILL after 5 s if still running.
 */
export function runGateCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<GateCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      child.kill('SIGTERM')
      sigkillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 5_000)
    }, timeoutMs)

    function settle(exitCode: number): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (sigkillTimer !== null) clearTimeout(sigkillTimer)
      resolve({ stdout, stderr, exitCode, timedOut })
    }

    child.on('close', (code: number | null) => settle(code ?? -1))
    child.on('error', () => settle(-1))
  })
}

// ── noOpGate ──────────────────────────────────────────────────────────────────

export interface NoOpGateContext {
  /** Paths the spec declared this task would touch. */
  declaredFiles: string[]
  /**
   * Every path git reports as touched in the worktree — committed or not — or
   * `null` when git could not be consulted (no worktree, or the command failed).
   * `null` is "no evidence", never "no changes".
   */
  changedFiles: string[] | null
  /** Agent name, used to find the file-reporting fields of its output contract. */
  agent: string
  /** Parsed OUTPUT_CONTRACT body, absent when the agent emitted none. */
  contractData?: Record<string, unknown>
}

/**
 * Fail a task that declared files and then produced none.
 *
 * An adapter exiting 0 says the process ended, not that the work happened. An
 * agent that is refused write permission tries, gives up, explains itself in
 * prose and exits cleanly — and every signal the engine used to look at reads as
 * success. The convoy then reports fully green with an empty branch behind it,
 * which is the failure surfacing at review time instead of at run time.
 *
 * Evidence is preferred in the order it can be trusted: what git says the
 * worktree holds, then what the agent said it did. Silence from both is not
 * evidence of a no-op — a task with no declared files, no worktree and no
 * contract passes, because nothing here contradicts it.
 *
 * The one deliberate false positive: a task whose only product is gitignored
 * leaves no trace for git to report and reads as a no-op. It fails loudly, with
 * the reason, after its retries — which is the trade this gate exists to make.
 * A spec that works that way sets `built_in_gates.no_op: false`.
 */
export function noOpGate(ctx: NoOpGateContext): { passed: boolean; output: string } {
  // The commonest cause, and the one hardest to see from the outside: a worker
  // with no terminal cannot answer a permission prompt, so every write it tries
  // is refused and it exits 0 anyway. Say so where the operator will read it.
  const hint =
    'If the agent was refused permission to write, raise `defaults.permission_mode` ' +
    '(acceptEdits, or bypassPermissions for a free hand).'
  const declared = ctx.declaredFiles.length
  if (declared === 0) {
    return { passed: true, output: 'No-op check: task declared no files' }
  }

  if (ctx.changedFiles !== null) {
    if (ctx.changedFiles.length > 0) {
      return { passed: true, output: `No-op check: ${ctx.changedFiles.length} file(s) changed in the worktree` }
    }
    return {
      passed: false,
      output:
        `Task declared ${declared} file(s) but the worktree has no changes — nothing was written.\n` +
        `Declared: ${ctx.declaredFiles.join(', ')}\n${hint}`,
    }
  }

  // No git evidence — fall back to the agent's own report.
  const fields = filePathFields(ctx.agent)
  if (!ctx.contractData || fields.length === 0) {
    return { passed: true, output: 'No-op check: no evidence available' }
  }
  const reported = fields.filter(f => Array.isArray(ctx.contractData![f]))
  if (reported.length === 0) {
    return { passed: true, output: 'No-op check: agent reported no file lists' }
  }
  if (reported.some(f => (ctx.contractData![f] as unknown[]).length > 0)) {
    return { passed: true, output: 'No-op check: agent reported files produced' }
  }
  return {
    passed: false,
    output:
      `Task declared ${declared} file(s) and the agent reported none produced (${reported.join(', ')} all empty).\n` +
      `Declared: ${ctx.declaredFiles.join(', ')}\n${hint}`,
  }
}

/**
 * Every path a worktree has touched relative to its base branch, or `null` when
 * git could not answer.
 *
 * Both halves matter: agents usually leave their work uncommitted for the merge
 * queue to stage, but an agent that commits its own work has changed the tree
 * just as much. Counting only one of the two would call half of the real runs a
 * no-op.
 */
export async function collectWorktreeChanges(
  worktreePath: string,
  baseRef: string,
): Promise<string[] | null> {
  const changed = new Set<string>()
  let answered = false

  // `-uall` because the default collapses a new directory to one entry, which
  // would report "nested/" where the task declared "nested/PILOT.md".
  const status = await runGateCommand(
    'git', ['status', '--porcelain', '-uall'], worktreePath, 30_000,
  )
  if (status.exitCode === 0) {
    answered = true
    for (const line of status.stdout.split('\n')) {
      // "XY path" — and "XY old -> new" for renames, where the new path is what exists.
      const path = line.slice(3).trim()
      if (!path) continue
      const arrow = path.lastIndexOf(' -> ')
      changed.add(arrow === -1 ? path : path.slice(arrow + 4))
    }
  }

  const committed = await runGateCommand(
    'git', ['diff', '--name-only', `${baseRef}..HEAD`], worktreePath, 30_000,
  )
  if (committed.exitCode === 0) {
    answered = true
    for (const path of committed.stdout.split('\n')) {
      if (path.trim()) changed.add(path.trim())
    }
  }

  return answered ? [...changed] : null
}

// ── runSecretScanGate ─────────────────────────────────────────────────────────

/** Scan a list of changed files in the worktree for secrets. */
export async function runSecretScanGate(
  changedFiles: string[],
  worktreePath: string,
): Promise<{ passed: boolean; output: string }> {
  const allFindings: SecretScanResult['findings'] = []

  for (const relPath of changedFiles) {
    const fullPath = join(worktreePath, relPath)
    let content: string
    try {
      content = await readFile(fullPath, 'utf-8')
    } catch {
      continue // Skip unreadable files (deleted, binary, etc.)
    }
    const result = scanForSecrets(content, relPath)
    allFindings.push(...result.findings)
  }

  if (allFindings.length === 0) {
    return { passed: true, output: `Secret scan: clean (${changedFiles.length} files scanned)` }
  }

  const lines = allFindings.map((f) => `  [${f.pattern}] ${f.file}:${f.line}: ${f.snippet}`)
  return {
    passed: false,
    output: `Secret scan: ${allFindings.length} finding(s) detected\n${lines.join('\n')}`,
  }
}

// ── runBlastRadiusGate ────────────────────────────────────────────────────────

/**
 * Analyze a git diff for blast radius.
 * WARN at 200+ lines OR 5+ files; BLOCK at 500+ lines OR 10+ files.
 */
export function runBlastRadiusGate(diff: string): {
  passed: boolean
  output: string
  level: 'ok' | 'warn' | 'block'
} {
  const diffLines = diff.split('\n')
  let linesChanged = 0
  let filesChanged = 0

  for (const line of diffLines) {
    if (line.startsWith('diff --git ')) {
      filesChanged++
    } else if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      linesChanged++
    }
  }

  const summary = `Blast radius: ${linesChanged} lines changed, ${filesChanged} files changed`

  if (linesChanged >= 500 || filesChanged >= 10) {
    return {
      passed: false,
      output: `${summary} — exceeds BLOCK threshold (500+ lines or 10+ files)`,
      level: 'block',
    }
  }
  if (linesChanged >= 200 || filesChanged >= 5) {
    return {
      passed: true,
      output: `${summary} — exceeds WARN threshold (200+ lines or 5+ files)`,
      level: 'warn',
    }
  }
  return { passed: true, output: `${summary} — within acceptable limits`, level: 'ok' }
}

// ── runDependencyAuditGate ────────────────────────────────────────────────────

/** Run npm audit in the worktree to detect high/critical vulnerabilities. */
export async function runDependencyAuditGate(
  worktreePath: string,
): Promise<{ passed: boolean; output: string }> {
  const result = await runGateCommand('npm', ['audit', '--json'], worktreePath, 300_000)
  if (result.exitCode === 0) {
    return { passed: true, output: 'Dependency audit: no vulnerabilities found' }
  }
  try {
    const auditData = JSON.parse(result.stdout) as {
      metadata?: { vulnerabilities?: { critical?: number; high?: number } }
    }
    const vulns = auditData.metadata?.vulnerabilities
    if (vulns) {
      const critical = vulns.critical ?? 0
      const high = vulns.high ?? 0
      if (critical > 0 || high > 0) {
        return {
          passed: false,
          output: `Dependency audit failed: ${critical} critical, ${high} high vulnerabilities\n${result.stdout}`,
        }
      }
    }
  } catch {
    // Fall through if JSON parse fails
  }
  return {
    passed: false,
    output: `Dependency audit failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
  }
}

// ── runRegressionTestGate ─────────────────────────────────────────────────────

/** Run the test suite in the worktree directory. */
export async function runRegressionTestGate(
  worktreePath: string,
  testCommand = 'npm test',
): Promise<{ passed: boolean; output: string }> {
  const parts = testCommand.split(' ')
  const cmd = parts[0]
  const args = parts.slice(1)
  const result = await runGateCommand(cmd, args, worktreePath, 300_000)
  if (result.exitCode === 0) {
    return { passed: true, output: `Regression test passed\n${result.stdout}` }
  }
  return {
    passed: false,
    output: `Regression test failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
  }
}

// ── PNG pixel diff ───────────────────────────────────────────────────────────

function parsePngDimensions(
  buf: Buffer,
): { width: number; height: number; colorType: number } | null {
  if (buf.length < 29) return null
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) return null
  }
  const chunkType = buf.slice(12, 16).toString('ascii')
  if (chunkType !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const colorType = buf[25]
  return { width, height, colorType }
}

function collectIdatData(buf: Buffer): Buffer {
  const chunks: Buffer[] = []
  let offset = 8
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.slice(offset + 4, offset + 8).toString('ascii')
    if (type === 'IEND') break
    if (type === 'IDAT') {
      chunks.push(buf.slice(offset + 8, offset + 8 + length))
    }
    offset += 8 + length + 4
  }
  return Buffer.concat(chunks)
}

function bytesPerPixelForColorType(colorType: number): number {
  switch (colorType) {
    case 0: return 1
    case 2: return 3
    case 3: return 1
    case 4: return 2
    case 6: return 4
    default: return 4
  }
}

/**
 * Compare two PNG buffers pixel-by-pixel and return the fraction (0–1) of differing pixels.
 * Returns 1.0 if dimensions differ, buffers are invalid, or an error occurs.
 */
export function pixelDiffPercentage(baselineBuffer: Buffer, currentBuffer: Buffer): number {
  try {
    const baseDims = parsePngDimensions(baselineBuffer)
    const currDims = parsePngDimensions(currentBuffer)
    if (!baseDims || !currDims) return 1.0
    if (baseDims.width !== currDims.width || baseDims.height !== currDims.height) return 1.0
    const { width, height, colorType } = baseDims
    const totalPixels = width * height
    if (totalPixels === 0) return 0
    const baseIdat = collectIdatData(baselineBuffer)
    const currIdat = collectIdatData(currentBuffer)
    const baseRaw = inflateSync(baseIdat)
    const currRaw = inflateSync(currIdat)
    const bpp = bytesPerPixelForColorType(colorType)
    const rowBytes = 1 + width * bpp
    let diffPixels = 0
    for (let row = 0; row < height; row++) {
      const rowOffset = row * rowBytes
      for (let col = 0; col < width; col++) {
        const pixelOffset = rowOffset + 1 + col * bpp
        let differs = false
        for (let channel = 0; channel < bpp; channel++) {
          const base = baseRaw[pixelOffset + channel] ?? 0
          const curr = currRaw[pixelOffset + channel] ?? 0
          if (Math.abs(base - curr) > 5) {
            differs = true
            break
          }
        }
        if (differs) diffPixels++
      }
    }
    return diffPixels / totalPixels
  } catch {
    return 1.0
  }
}

export interface VisualDiffContext {
  screenshotBuffer: Buffer
  baselinePath: string
  threshold: number
}

export interface VisualDiffResult {
  passed: boolean
  diffPercent: number
  output: string
}

/** Compare a screenshot buffer against a saved baseline PNG. */
export async function computeVisualDiff(context: VisualDiffContext): Promise<VisualDiffResult> {
  const { screenshotBuffer, baselinePath, threshold } = context
  if (!existsSync(baselinePath)) {
    return { passed: true, diffPercent: 0, output: 'No baseline found — skipping visual diff' }
  }
  const scanResult = scanForSecrets(screenshotBuffer.toString('base64'), 'screenshot')
  if (!scanResult.clean) {
    return {
      passed: false,
      diffPercent: 1.0,
      output: 'Screenshot scan: potential secrets detected in screenshot data',
    }
  }
  const baselineBuffer = readFileSync(baselinePath)
  const diffPercent = pixelDiffPercentage(baselineBuffer, screenshotBuffer)
  const passed = diffPercent <= threshold
  return {
    passed,
    diffPercent,
    output: passed
      ? `Visual diff: PASS (${(diffPercent * 100).toFixed(2)}% diff, threshold: ${
          (threshold * 100).toFixed(2)
        }%)`
      : `Visual diff: FAIL (${(diffPercent * 100).toFixed(2)}% diff exceeds threshold: ${
          (threshold * 100).toFixed(2)
        }%)`,
  }
}

/**
 * Persist a screenshot buffer as a PNG baseline file.
 * Secret-scans the buffer (as base64) before writing.
 */
export function captureAndPersistBaseline(
  screenshotBuffer: Buffer,
  slug: string,
  basePath = '.opencastle/baselines',
): { persisted: boolean; reason?: string } {
  const scanResult = scanForSecrets(screenshotBuffer.toString('base64'), 'screenshot')
  if (!scanResult.clean) {
    return { persisted: false, reason: 'secrets_detected' }
  }
  mkdirSync(basePath, { recursive: true })
  writeFileSync(join(basePath, `${slug}.png`), screenshotBuffer)
  return { persisted: true }
}

// ── A11y audit ────────────────────────────────────────────────────────────────

export type A11ySeverity = 'critical' | 'serious' | 'moderate' | 'minor'

const A11Y_SEVERITY_RANK: Record<A11ySeverity, number> = {
  critical: 4,
  serious: 3,
  moderate: 2,
  minor: 1,
}

export interface A11yFinding {
  id: string
  impact: A11ySeverity
  description: string
  nodes: number
}

/**
 * Map a list of a11y findings against a severity threshold.
 * Returns passed:false if any finding meets or exceeds the threshold.
 */
export function mapA11ySeverity(
  findings: A11yFinding[],
  threshold: A11ySeverity,
): { passed: boolean; output: string; findings: A11yFinding[] } {
  const thresholdRank = A11Y_SEVERITY_RANK[threshold]
  const failing = findings.filter((f) => A11Y_SEVERITY_RANK[f.impact] >= thresholdRank)
  if (failing.length === 0) {
    return {
      passed: true,
      output: `A11y audit: PASS (0 findings at or above ${threshold} severity)`,
      findings: [],
    }
  }
  const countBySeverity: Record<string, number> = {}
  for (const f of failing) {
    countBySeverity[f.impact] = (countBySeverity[f.impact] ?? 0) + 1
  }
  const countSummary = Object.entries(countBySeverity)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')
  const descriptions = failing
    .map((f) => `  [${f.impact}] ${f.id}: ${f.description.slice(0, 200)}`)
    .join('\n')
  return {
    passed: false,
    output: `A11y audit: FAIL (${countSummary})\n${descriptions}`,
    findings: failing,
  }
}

export interface A11yAuditContext {
  mcpServers: MCPServerConfig[]
  url: string
  severityThreshold: A11ySeverity
}

/** Run an a11y audit via a browser-capable MCP server. */
export async function runA11yAudit(
  context: A11yAuditContext,
): Promise<{ passed: boolean; output: string; findings: A11yFinding[] }> {
  const { mcpServers, url, severityThreshold } = context
  if (!isLocalUrl(url)) {
    return {
      passed: false,
      output: `A11y audit blocked: URL "${url}" is not a local address. Only localhost/127.0.0.1/[::1] URLs are allowed.`,
      findings: [],
    }
  }
  const browserServer = mcpServers.find(
    (s) =>
      /browser|chrome|playwright|devtools/i.test(s.name) ||
      /browser|chrome|playwright|devtools/i.test(s.type),
  )
  if (!browserServer?.command) {
    return {
      passed: false,
      output: 'A11y audit: no browser-capable MCP server found',
      findings: [],
    }
  }
  const result = await runGateCommand(
    browserServer.command,
    [...(browserServer.args ?? []), '--a11y-audit', '--urls', url],
    process.cwd(),
    60_000,
  )
  const scanResult = scanForSecrets(result.stdout, 'a11y-audit-output')
  if (!scanResult.clean) {
    return {
      passed: false,
      output: 'A11y audit: output contained potential secrets (redacted)',
      findings: [],
    }
  }
  let findings: A11yFinding[] = []
  try {
    findings = JSON.parse(result.stdout) as A11yFinding[]
  } catch {
    return {
      passed: result.exitCode === 0,
      output:
        result.exitCode === 0
          ? 'A11y audit: PASS (no structured output)'
          : `A11y audit: failed to parse output (exit ${result.exitCode}): ${
              result.stderr || result.stdout
            }`,
      findings: [],
    }
  }
  return mapA11ySeverity(findings, severityThreshold)
}

// ── browserTestGate ───────────────────────────────────────────────────────────

/**
 * Validate that a URL points to localhost/127.0.0.1/[::1] only.
 * Prevents SSRF by rejecting any external addresses.
 */
function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export interface BrowserTestContext {
  mcpServers: MCPServerConfig[]
  taskConfig: BrowserTestConfig
  worktreePath: string
  approvalTimeout?: number
}

/**
 * Run browser-based tests against localhost URLs using an MCP browser server.
 * All URLs are validated to be local addresses (SSRF prevention).
 */
export async function browserTestGate(
  context: BrowserTestContext,
): Promise<{ passed: boolean; output: string }> {
  const { mcpServers, taskConfig, worktreePath } = context
  const results: string[] = []
  let allPassed = true

  // Validate URLs — only allow localhost to prevent SSRF
  for (const url of taskConfig.urls) {
    if (!isLocalUrl(url)) {
      return {
        passed: false,
        output: `Browser test gate blocked: URL "${url}" is not a local address. Only localhost/127.0.0.1/[::1] URLs are allowed.`,
      }
    }
  }

  // Find browser-capable MCP server
  const browserServer = mcpServers.find(
    (s) =>
      /browser|chrome|playwright|devtools/i.test(s.name) ||
      /browser|chrome|playwright|devtools/i.test(s.type),
  )

  if (!browserServer) {
    return {
      passed: false,
      output: 'Browser test gate: no browser-capable MCP server found in defaults.mcp_servers',
    }
  }

  // Test each URL via curl
  for (const url of taskConfig.urls) {
    const curlResult = await runGateCommand(
      'curl',
      ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30', url],
      worktreePath,
      35_000,
    )

    if (curlResult.timedOut) {
      allPassed = false
      results.push(`  \u2717 ${url}: timed out`)
    } else {
      const statusCode = parseInt(curlResult.stdout.trim(), 10)
      if (isNaN(statusCode) || statusCode >= 400) {
        allPassed = false
        results.push(`  \u2717 ${url}: HTTP ${curlResult.stdout.trim() || 'error'} (exit ${curlResult.exitCode})`)
      } else {
        results.push(`  \u2713 ${url}: HTTP ${statusCode}`)
      }
    }
  }

  // If browser MCP server has a command, attempt browser automation
  if (browserServer.command) {
    const browserArgs = [...(browserServer.args ?? []), '--urls', ...taskConfig.urls]
    if (taskConfig.check_console_errors) browserArgs.push('--check-console-errors')

    const timeoutMs = (context.approvalTimeout ?? 60) * 1000
    const browserResult = await runGateCommand(
      browserServer.command,
      browserArgs,
      worktreePath,
      timeoutMs,
    )

    if (browserResult.exitCode !== 0) {
      allPassed = false
      results.push(
        `  Browser automation failed (exit ${browserResult.exitCode}): ${browserResult.stderr || browserResult.stdout}`,
      )
    } else {
      const scanResult = scanForSecrets(browserResult.stdout, 'browser-test-output')
      if (!scanResult.clean) {
        results.push(`  \u26a0 Browser output contained potential secrets (redacted)`)
      } else {
        results.push(`  Browser automation passed`)
        if (taskConfig.check_console_errors && browserResult.stdout.includes('[console.error]')) {
          allPassed = false
          results.push(`  \u2717 Console errors detected in browser output`)
        }
      }
    }
  }

  // Visual diff check (if visual_diff_threshold is set and browser server has a command)
  if (taskConfig.visual_diff_threshold !== undefined && browserServer?.command) {
    const baselinesDir = join(worktreePath, taskConfig.baselines_dir ?? '.opencastle/baselines')
    for (const url of taskConfig.urls) {
      const slug = url.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
      const ssResult = await runGateCommand(
        browserServer.command,
        [...(browserServer.args ?? []), '--screenshot', '--urls', url],
        worktreePath,
        (context.approvalTimeout ?? 60) * 1000,
      )
      if (ssResult.exitCode !== 0) {
        allPassed = false
        results.push(`  Visual diff ${url}: screenshot failed (exit ${ssResult.exitCode})`)
        continue
      }
      const screenshotBuffer = Buffer.from(ssResult.stdout)
      const baselinePath = join(baselinesDir, `${slug}.png`)
      const diffResult = await computeVisualDiff({
        screenshotBuffer,
        baselinePath,
        threshold: taskConfig.visual_diff_threshold,
      })
      results.push(`  Visual diff ${url}: ${diffResult.output}`)
      if (!diffResult.passed) allPassed = false
    }
  }

  // A11y audit (if a11y is enabled)
  if (taskConfig.a11y) {
    for (const url of taskConfig.urls) {
      const a11yResult = await runA11yAudit({
        mcpServers,
        url,
        severityThreshold: taskConfig.severity_threshold ?? 'serious',
      })
      results.push(`  A11y ${url}: ${a11yResult.output}`)
      if (!a11yResult.passed) allPassed = false
    }
  }

  return {
    passed: allPassed,
    output: `Browser test gate: ${allPassed ? 'PASS' : 'FAIL'}\n${results.join('\n')}`,
  }
}
