import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CLAUDE_SETTINGS,
  VSCODE_HOOK_FILE,
  memoryHookCommand,
  memoryHookPaths,
  memoryHooksDrift,
  stripMemoryHooks,
  writeMemoryHooks,
} from './memory-hooks.js'

describe('memory hooks', () => {
  let dir: string
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8')
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const settings = (): { hooks?: { SessionEnd?: Array<{ hooks: Array<{ command: string }> }> }; [k: string]: unknown } =>
    JSON.parse(read(CLAUDE_SETTINGS))
  const ourCommands = (): string[] =>
    (settings().hooks?.SessionEnd ?? []).flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes('promote memory'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-memory-hooks-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs the project’s own copy when it has one, and the compiling release when not', () => {
    expect(memoryHookCommand(dir, '1.8.0')).toBe('npx -y opencastle@1.8.0 promote memory --json')
    write('package.json', JSON.stringify({ devDependencies: { opencastle: '^1.8.0' } }))
    expect(memoryHookCommand(dir, '1.8.0')).toBe('npx --no opencastle promote memory --json')
  })

  it('writes a SessionEnd hook for Claude Code and a Stop hook for VS Code', () => {
    const out = writeMemoryHooks(dir, ['claude-code', 'vscode'], '1.8.0')
    expect(out).toEqual([
      { path: CLAUDE_SETTINGS, outcome: 'created' },
      { path: VSCODE_HOOK_FILE, outcome: 'created' },
    ])
    expect(settings()).toEqual({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'npx -y opencastle@1.8.0 promote memory --json', timeout: 30 }] }] },
    })
    expect(JSON.parse(read(VSCODE_HOOK_FILE))).toEqual({
      hooks: { Stop: [{ type: 'command', command: 'npx -y opencastle@1.8.0 promote memory --json', timeout: 30 }] },
    })
    expect(memoryHooksDrift(dir, ['claude-code', 'vscode'], '1.8.0')).toEqual([])
  })

  it('adds its entry beside the project’s own settings and hooks, and changes nothing on a second run', () => {
    write(CLAUDE_SETTINGS, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }], PreToolUse: [] } }))
    expect(writeMemoryHooks(dir, ['claude-code'], '1.8.0')).toEqual([{ path: CLAUDE_SETTINGS, outcome: 'updated' }])
    const first = read(CLAUDE_SETTINGS)
    expect(settings().permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect((settings().hooks as Record<string, unknown>).PreToolUse).toEqual([])
    expect(settings().hooks?.SessionEnd?.[0].hooks[0].command).toBe('echo bye')
    expect(ourCommands()).toEqual(['npx -y opencastle@1.8.0 promote memory --json'])
    expect(writeMemoryHooks(dir, ['claude-code'], '1.8.0')).toEqual([{ path: CLAUDE_SETTINGS, outcome: 'unchanged' }])
    expect(read(CLAUDE_SETTINGS)).toBe(first)
  })

  it('replaces its own entry when the release changes, and keeps just one', () => {
    writeMemoryHooks(dir, ['claude-code'], '1.8.0')
    expect(memoryHooksDrift(dir, ['claude-code'], '1.9.0')).toHaveLength(1)
    writeMemoryHooks(dir, ['claude-code'], '1.9.0')
    expect(ourCommands()).toEqual(['npx -y opencastle@1.9.0 promote memory --json'])
  })

  it('leaves a settings file it cannot read alone, and says so', () => {
    write(CLAUDE_SETTINGS, '{ "hooks": ')
    expect(writeMemoryHooks(dir, ['claude-code'], '1.8.0')).toEqual([{ path: CLAUDE_SETTINGS, outcome: 'unreadable' }])
    expect(read(CLAUDE_SETTINGS)).toBe('{ "hooks": ')
    expect(memoryHooksDrift(dir, ['claude-code'], '1.8.0')[0].unreadable).toBe(true)
  })

  it('reports a hook that was removed or edited', () => {
    writeMemoryHooks(dir, ['claude-code', 'vscode'], '1.8.0')
    write(CLAUDE_SETTINGS, JSON.stringify({ permissions: {} }))
    write(VSCODE_HOOK_FILE, '{"hooks":{}}\n')
    expect(memoryHooksDrift(dir, ['claude-code', 'vscode'], '1.8.0').map((d) => d.path)).toEqual([CLAUDE_SETTINGS, VSCODE_HOOK_FILE])
    expect(memoryHooksDrift(dir, ['cursor'], '1.8.0')).toEqual([])
  })

  it('takes back only its own: the entry from the settings, and its hook file', () => {
    write(CLAUDE_SETTINGS, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }))
    writeMemoryHooks(dir, ['claude-code', 'vscode'], '1.8.0')
    expect(memoryHookPaths(dir)).toEqual([CLAUDE_SETTINGS, VSCODE_HOOK_FILE])
    expect(stripMemoryHooks(dir)).toEqual([CLAUDE_SETTINGS, VSCODE_HOOK_FILE])
    expect(settings()).toEqual({ permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } })
    expect(existsSync(join(dir, VSCODE_HOOK_FILE))).toBe(false)
    expect(memoryHookPaths(dir)).toEqual([])
  })

  it('deletes a settings file that held nothing but its hook', () => {
    writeMemoryHooks(dir, ['claude-code'], '1.8.0')
    stripMemoryHooks(dir)
    expect(existsSync(join(dir, CLAUDE_SETTINGS))).toBe(false)
  })
})
