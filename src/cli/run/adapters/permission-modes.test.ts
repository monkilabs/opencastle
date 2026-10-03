/**
 * A permission mode is honoured or refused, never dropped.
 *
 * The defect: `--permission-mode` was validated against the enum, stored on the
 * spec, threaded through four call sites in the engine, handed to the adapter —
 * and read by one of the five. A run told to hold its workers to `plan` wrote
 * files anyway, on `codex`, `cursor`, `opencode` and `copilot` alike. Each CLI
 * now has a mapping; these tests pin what each mode becomes.
 */
import { describe, it, expect } from 'vitest'
import {
  ADAPTER_PERMISSION_MODES,
  meaningOf,
  codexSandboxFor,
  copilotPermissionArgs,
  opencodePermission,
  cursorPermissionArgs,
  supportsPermissionMode,
  permissionModeError,
} from './permission-modes.js'
import { PERMISSION_MODES } from '../../convoy/spec-types.js'

describe('the capability table', () => {
  it('covers every registered adapter', () => {
    for (const name of ['claude', 'codex', 'cursor', 'opencode', 'copilot']) {
      expect(ADAPTER_PERMISSION_MODES[name], `${name} declares no modes`).toBeDefined()
    }
  })

  it('names only modes that exist in the enum', () => {
    for (const [adapter, modes] of Object.entries(ADAPTER_PERMISSION_MODES)) {
      for (const mode of modes) {
        expect(PERMISSION_MODES, `${adapter} declares unknown mode ${mode}`).toContain(mode)
      }
    }
  })

  it('lets every runtime run read-only, so the planner can use any of them', () => {
    for (const name of ['claude', 'codex', 'cursor', 'opencode', 'copilot']) {
      expect(supportsPermissionMode(name, 'plan'), name).toBe(true)
    }
  })
})

describe('meaningOf', () => {
  it('reduces the modes to read-only, edits and everything', () => {
    expect(meaningOf('plan')).toBe('read-only')
    // In a headless run `default` can only refuse what it would have asked about.
    expect(meaningOf('default')).toBe('read-only')
    expect(meaningOf(undefined)).toBe('edits')
    expect(meaningOf('acceptEdits')).toBe('edits')
    expect(meaningOf('auto')).toBe('edits')
    expect(meaningOf('dontAsk')).toBe('edits')
    expect(meaningOf('bypassPermissions')).toBe('everything')
  })
})

describe('codexSandboxFor', () => {
  it('leaves the default run exactly as it was', () => {
    expect(codexSandboxFor(undefined)).toBe('workspace-write')
    expect(codexSandboxFor('acceptEdits')).toBe('workspace-write')
  })

  it('makes a worker read-only when it was told to write nothing', () => {
    expect(codexSandboxFor('default')).toBe('read-only')
    expect(codexSandboxFor('plan')).toBe('read-only')
  })

  it('widens the sandbox only when explicitly asked', () => {
    expect(codexSandboxFor('bypassPermissions')).toBe('danger-full-access')
  })
})

describe('copilotPermissionArgs', () => {
  it('denies writes and commands for read-only — denials beat any allow, even COPILOT_ALLOW_ALL', () => {
    expect(copilotPermissionArgs('plan')).toEqual(['--deny-tool=write', '--deny-tool=shell'])
  })

  it('allows file edits by default, and no longer approves everything', () => {
    expect(copilotPermissionArgs(undefined)).toEqual(['--allow-tool=write'])
    expect(copilotPermissionArgs('acceptEdits')).not.toContain('--allow-all')
  })

  it('allows everything only for bypassPermissions', () => {
    expect(copilotPermissionArgs('bypassPermissions')).toEqual(['--allow-all'])
  })
})

describe('opencodePermission', () => {
  it('denies the edit and bash tools for read-only', () => {
    expect(opencodePermission('plan')).toEqual({ args: [], permission: { edit: 'deny', bash: 'deny' } })
  })

  it('keeps `opencode run` as it is for edits, and approves questions only for everything', () => {
    expect(opencodePermission('acceptEdits')).toEqual({ args: [] })
    expect(opencodePermission('bypassPermissions')).toEqual({ args: ['--auto'] })
  })
})

describe('cursorPermissionArgs', () => {
  it('applies edits only with --force', () => {
    expect(cursorPermissionArgs('acceptEdits')).toEqual(['--force'])
    expect(cursorPermissionArgs('plan')).not.toContain('--force')
  })

  it('trusts the worktree and asks only questions for read-only', () => {
    expect(cursorPermissionArgs('plan')).toEqual(['--trust', '--mode', 'ask'])
  })

  it('turns the sandbox off only for bypassPermissions', () => {
    expect(cursorPermissionArgs('bypassPermissions')).toEqual(['--force', '--sandbox', 'disabled', '--approve-mcps'])
    expect(cursorPermissionArgs('acceptEdits')).not.toContain('--sandbox')
  })
})

describe('supportsPermissionMode', () => {
  it('accepts every mode on every adapter that maps them all', () => {
    for (const mode of PERMISSION_MODES) {
      for (const name of ['claude', 'codex', 'cursor', 'opencode', 'copilot']) {
        expect(supportsPermissionMode(name, mode)).toBe(true)
      }
    }
  })

  it('does not second-guess an adapter it has never heard of', () => {
    expect(supportsPermissionMode('some-future-adapter', 'plan')).toBe(true)
  })
})

describe('permissionModeError', () => {
  it('is null when the mode can be honoured', () => {
    expect(permissionModeError('claude', 'plan')).toBeNull()
    expect(permissionModeError('cursor', 'plan')).toBeNull()
    expect(permissionModeError('codex', 'bypassPermissions')).toBeNull()
  })
})
