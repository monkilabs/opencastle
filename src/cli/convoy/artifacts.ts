import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Artifact {
  task_id: string
  convoy_id: string
  filename: string
  type: 'report' | 'code' | 'data' | 'diff' | 'log' | 'other'
  size_bytes: number
  summary: string
  path: string
}

export interface ArtifactRef {
  task_id: string
  filename: string
  summary: string
  path: string
}

interface ArtifactMeta {
  type: Artifact['type']
  summary: string
  size_bytes: number
  created_at: string
}

// ── Sanitization ──────────────────────────────────────────────────────────────

function sanitizeSegment(input: string): string {
  if (input.includes('..') || input.includes('/') || input.includes('\\')) {
    throw new Error(`Invalid path segment "${input}": path traversal characters not allowed`)
  }
  return input.replace(/[^a-zA-Z0-9\-_.]/g, '')
}

// ── Core ──────────────────────────────────────────────────────────────────────

export function getArtifactDir(convoyId: string, taskId: string, basePath?: string): string {
  const safeConvoyId = sanitizeSegment(convoyId)
  const safeTaskId = sanitizeSegment(taskId)
  return join(basePath ?? process.cwd(), '.opencastle', 'artifacts', safeConvoyId, safeTaskId) + '/'
}

export function writeArtifact(
  convoyId: string,
  taskId: string,
  filename: string,
  content: string,
  type: Artifact['type'],
): Artifact {
  const safeFilename = sanitizeSegment(filename)
  const dir = getArtifactDir(convoyId, taskId)
  mkdirSync(dir, { recursive: true })

  const filePath = join(dir, safeFilename)
  writeFileSync(filePath, content, 'utf8')

  const size_bytes = Buffer.byteLength(content, 'utf8')
  const firstLine = content.split('\n')[0] ?? ''
  const summary = firstLine.slice(0, 120)

  const meta: ArtifactMeta = { type, summary, size_bytes, created_at: new Date().toISOString() }
  writeFileSync(join(dir, safeFilename + '.meta.json'), JSON.stringify(meta, null, 2), 'utf8')

  return { task_id: taskId, convoy_id: convoyId, filename: safeFilename, type, size_bytes, summary, path: filePath }
}

export function listArtifacts(convoyId: string, taskId: string): ArtifactRef[] {
  const dir = getArtifactDir(convoyId, taskId)
  if (!existsSync(dir)) return []

  const refs: ArtifactRef[] = []
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.meta.json')) continue

    const filePath = join(dir, entry)
    const metaPath = join(dir, entry + '.meta.json')

    let summary = ''
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ArtifactMeta
        summary = meta.summary
      } catch { /* fallback */ }
    }
    if (!summary) {
      try {
        const firstLine = readFileSync(filePath, 'utf8').split('\n')[0] ?? ''
        summary = firstLine.slice(0, 120)
      } catch { /* non-critical */ }
    }

    refs.push({ task_id: taskId, filename: entry, summary, path: filePath })
  }

  return refs
}

export function readArtifact(ref: ArtifactRef): string {
  return readFileSync(ref.path, 'utf8')
}

export function extractArtifactRefs(taskId: string, convoyId: string, output: string): ArtifactRef[] {
  const pattern = /\[ARTIFACT:\s*([^\]]+)\]\s*(.+)/g
  const refs: ArtifactRef[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(output)) !== null) {
    // Use basename to prevent path traversal from untrusted agent output
    const filename = basename(match[1].trim())
    const summary = match[2].trim()

    if (!filename || filename === '..') {
      process.stderr.write('[artifacts] Warning: invalid artifact filename from agent output\n')
      continue
    }

    const dir = getArtifactDir(convoyId, taskId)
    const filePath = join(dir, filename)

    if (!existsSync(filePath)) {
      process.stderr.write(`[artifacts] Warning: referenced artifact not found: ${filePath}\n`)
      continue
    }

    refs.push({ task_id: taskId, filename, summary, path: filePath })
  }

  return refs
}

export function pruneArtifacts(keepCount: number, basePath?: string): { removed: number; freed_bytes: number } {
  const artifactsRoot = join(basePath ?? process.cwd(), '.opencastle', 'artifacts')
  if (!existsSync(artifactsRoot)) return { removed: 0, freed_bytes: 0 }

  const convoyDirs = readdirSync(artifactsRoot)
    .map(name => {
      const dirPath = join(artifactsRoot, name)
      try {
        return { name, path: dirPath, mtime: statSync(dirPath).mtime.getTime() }
      } catch {
        return { name, path: dirPath, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)

  const toRemove = convoyDirs.slice(keepCount)
  let removed = 0
  let freed_bytes = 0

  for (const dir of toRemove) {
    try {
      freed_bytes += calcDirSize(dir.path)
      rmSync(dir.path, { recursive: true, force: true })
      removed++
    } catch { /* non-critical */ }
  }

  return { removed, freed_bytes }
}

function calcDirSize(dirPath: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(dirPath)) {
      const p = join(dirPath, entry)
      try {
        const s = statSync(p)
        if (s.isDirectory()) total += calcDirSize(p)
        else total += s.size
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total
}
