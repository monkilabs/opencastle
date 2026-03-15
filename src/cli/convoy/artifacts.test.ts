import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getArtifactDir,
  writeArtifact,
  listArtifacts,
  readArtifact,
  extractArtifactRefs,
  pruneArtifacts,
} from './artifacts.js'

describe('artifacts', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'artifacts-test-'))
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('writeArtifact', () => {
    it('creates file in correct directory structure', () => {
      const artifact = writeArtifact('convoy-1', 'task-1', 'report.md', '# Report\nContent here', 'report')
      expect(artifact.path).toContain('convoy-1')
      expect(artifact.path).toContain('task-1')
      expect(artifact.path).toContain('report.md')
      expect(existsSync(artifact.path)).toBe(true)
    })

    it('creates .meta.json sidecar', () => {
      const artifact = writeArtifact('convoy-1', 'task-1', 'report.md', '# Report\nContent here', 'report')
      const metaPath = artifact.path + '.meta.json'
      expect(existsSync(metaPath)).toBe(true)
    })

    it('returns Artifact with correct metadata', () => {
      const content = '# Report\nLine 2'
      const artifact = writeArtifact('convoy-1', 'task-1', 'report.md', content, 'report')
      expect(artifact.task_id).toBe('task-1')
      expect(artifact.convoy_id).toBe('convoy-1')
      expect(artifact.filename).toBe('report.md')
      expect(artifact.type).toBe('report')
      expect(artifact.size_bytes).toBe(Buffer.byteLength(content, 'utf8'))
      expect(artifact.summary).toBe('# Report')
    })

    it('summary is truncated to 120 chars when first line is long', () => {
      const longFirstLine = 'A'.repeat(200)
      const content = longFirstLine + '\nSecond line'
      const artifact = writeArtifact('convoy-1', 'task-1', 'long.md', content, 'report')
      expect(artifact.summary.length).toBe(120)
    })
  })

  describe('listArtifacts', () => {
    it('returns refs for all files in task dir excluding .meta.json', () => {
      writeArtifact('convoy-1', 'task-1', 'report.md', '# Report', 'report')
      writeArtifact('convoy-1', 'task-1', 'migration.sql', 'ALTER TABLE users', 'code')
      const refs = listArtifacts('convoy-1', 'task-1')
      expect(refs).toHaveLength(2)
      const filenames = refs.map(r => r.filename)
      expect(filenames).toContain('report.md')
      expect(filenames).toContain('migration.sql')
    })

    it('returns empty array when dir does not exist', () => {
      const refs = listArtifacts('nonexistent-convoy', 'nonexistent-task')
      expect(refs).toHaveLength(0)
    })

    it('populates summary from .meta.json sidecar', () => {
      writeArtifact('convoy-1', 'task-1', 'diff.patch', 'diff --git a/file.ts\nchanges here', 'diff')
      const refs = listArtifacts('convoy-1', 'task-1')
      expect(refs[0].summary).toBe('diff --git a/file.ts')
    })
  })

  describe('readArtifact', () => {
    it('returns file content', () => {
      const content = '# Report\nDetailed content here'
      const artifact = writeArtifact('convoy-1', 'task-1', 'report.md', content, 'report')
      const ref = { task_id: 'task-1', filename: 'report.md', summary: '# Report', path: artifact.path }
      expect(readArtifact(ref)).toBe(content)
    })
  })

  describe('extractArtifactRefs', () => {
    it('parses [ARTIFACT: filename] summary pattern correctly', () => {
      writeArtifact('convoy-1', 'task-1', 'report.md', '# Report', 'report')
      const output = 'I completed the work.\n[ARTIFACT: report.md] Full analysis report\nSee the artifact for details.'
      const refs = extractArtifactRefs('task-1', 'convoy-1', output)
      expect(refs).toHaveLength(1)
      expect(refs[0].filename).toBe('report.md')
      expect(refs[0].summary).toBe('Full analysis report')
    })

    it('parses multiple artifacts in one output', () => {
      writeArtifact('convoy-1', 'task-1', 'report.md', '# Report', 'report')
      writeArtifact('convoy-1', 'task-1', 'migration.sql', 'ALTER TABLE', 'code')
      const output = '[ARTIFACT: report.md] Analysis report\n[ARTIFACT: migration.sql] Database migration script'
      const refs = extractArtifactRefs('task-1', 'convoy-1', output)
      expect(refs).toHaveLength(2)
    })

    it('logs warning to stderr for referenced but missing artifacts', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const output = '[ARTIFACT: missing.md] A report that does not exist on disk'
      const refs = extractArtifactRefs('task-1', 'convoy-1', output)
      expect(refs).toHaveLength(0)
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[artifacts] Warning'))
    })

    it('returns empty array when no artifact patterns found', () => {
      const refs = extractArtifactRefs('task-1', 'convoy-1', 'No artifacts here, just a normal response.')
      expect(refs).toHaveLength(0)
    })
  })

  describe('pruneArtifacts', () => {
    it('removes convoy dirs beyond keepCount', () => {
      writeArtifact('convoy-a', 'task-1', 'file.md', 'content', 'report')
      writeArtifact('convoy-b', 'task-1', 'file.md', 'content', 'report')
      writeArtifact('convoy-c', 'task-1', 'file.md', 'content', 'report')
      const result = pruneArtifacts(1)
      expect(result.removed).toBe(2)
      expect(result.freed_bytes).toBeGreaterThan(0)
    })

    it('returns zero removed when within keepCount', () => {
      writeArtifact('convoy-1', 'task-1', 'file.md', 'content', 'report')
      writeArtifact('convoy-2', 'task-1', 'file.md', 'content', 'report')
      const result = pruneArtifacts(5)
      expect(result.removed).toBe(0)
      expect(result.freed_bytes).toBe(0)
    })

    it('returns zero when no artifacts directory exists', () => {
      const result = pruneArtifacts(10)
      expect(result.removed).toBe(0)
      expect(result.freed_bytes).toBe(0)
    })

    it('returns correct freed bytes count', () => {
      const content = 'A'.repeat(1000)
      writeArtifact('convoy-old1', 'task-1', 'large.md', content, 'report')
      writeArtifact('convoy-old2', 'task-1', 'large.md', content, 'report')
      writeArtifact('convoy-new', 'task-1', 'large.md', content, 'report')
      const result = pruneArtifacts(1)
      expect(result.removed).toBe(2)
      expect(result.freed_bytes).toBeGreaterThan(0)
    })
  })

  describe('round-trip', () => {
    it('write → list → read produces identical content', () => {
      const content = '# Report\nLine 2\nLine 3'
      writeArtifact('convoy-1', 'task-1', 'report.md', content, 'report')
      const refs = listArtifacts('convoy-1', 'task-1')
      expect(refs).toHaveLength(1)
      const retrieved = readArtifact(refs[0])
      expect(retrieved).toBe(content)
    })
  })

  describe('path sanitization', () => {
    it('rejects filenames with ..', () => {
      expect(() => writeArtifact('convoy-1', 'task-1', '../evil.ts', 'content', 'code')).toThrow()
    })

    it('rejects filenames with /', () => {
      expect(() => writeArtifact('convoy-1', 'task-1', 'sub/evil.ts', 'content', 'code')).toThrow()
    })

    it('rejects convoy IDs with path traversal', () => {
      expect(() => writeArtifact('../evil', 'task-1', 'file.md', 'content', 'report')).toThrow()
    })

    it('rejects task IDs with backslash', () => {
      expect(() => writeArtifact('convoy-1', 'task\\evil', 'file.md', 'content', 'report')).toThrow()
    })
  })

  describe('getArtifactDir', () => {
    it('returns path ending with trailing slash', () => {
      const dir = getArtifactDir('convoy-1', 'task-1')
      expect(dir.endsWith('/')).toBe(true)
    })

    it('includes convoy-id and task-id in path', () => {
      const dir = getArtifactDir('convoy-abc', 'task-xyz')
      expect(dir).toContain('convoy-abc')
      expect(dir).toContain('task-xyz')
    })
  })
})
