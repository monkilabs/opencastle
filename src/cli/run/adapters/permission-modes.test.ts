/**
 * A permission mode is honoured or refused, never dropped.
 *
 * The defect: `--permission-mode` was validated against the enum, stored on the
 * spec, threaded through four call sites in the engine, handed to the adapter —
 * and read by one of the five. A run told to hold its workers to `plan` wrote
 * files anyway, on `codex`, `cursor`, `opencode` and `copilot` alike.
 */
import { describe, it, expect } from 'vitest'
import {
  ADAPTER_PERMISSION_MODES,
  codexSandboxFor,
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

  it('lets claude and codex carry the whole enum', () => {
    expect([...ADAPTER_PERMISSION_MODES.claude].sort()).toEqual([...PERMISSION_MODES].sort())
    expect([...ADAPTER_PERMISSION_MODES.codex].sort()).toEqual([...PERMISSION_MODES].sort())
  })

  it('does not claim read-only or bypass for the runtimes that have no such flag', () => {
    for (const name of ['cursor', 'opencode', 'copilot']) {
      expect(ADAPTER_PERMISSION_MODES[name]).not.toContain('plan')
      expect(ADAPTER_PERMISSION_MODES[name]).not.toContain('default')
      expect(ADAPTER_PERMISSION_MODES[name]).not.toContain('bypassPermissions')
    }
  })
})

describe('codexSandboxFor', () => {
  it('leaves the default run exactly as it was', () => {
    // acceptEdits is the default mode, and workspace-write is what the adapter
    // has always passed. This fix must not change an unconfigured run.
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

  it('treats the do-not-ask modes as ordinary edit access', () => {
    expect(codexSandboxFor('auto')).toBe('workspace-write')
    expect(codexSandboxFor('dontAsk')).toBe('workspace-write')
  })

  it('never returns the same sandbox for plan and bypassPermissions', () => {
    // The shipped behaviour: both were workspace-write, because the value was
    // hardcoded and the mode never read.
    expect(codexSandboxFor('plan')).not.toBe(codexSandboxFor('bypassPermissions'))
  })
})

describe('supportsPermissionMode', () => {
  it('accepts every mode on the adapters that map them all', () => {
    for (const mode of PERMISSION_MODES) {
      expect(supportsPermissionMode('claude', mode)).toBe(true)
      expect(supportsPermissionMode('codex', mode)).toBe(true)
    }
  })

  it('refuses a mode the runtime cannot express', () => {
    expect(supportsPermissionMode('cursor', 'plan')).toBe(false)
    expect(supportsPermissionMode('opencode', 'default')).toBe(false)
    expect(supportsPermissionMode('copilot', 'bypassPermissions')).toBe(false)
  })

  it('accepts what those runtimes actually do', () => {
    expect(supportsPermissionMode('cursor', 'acceptEdits')).toBe(true)
    expect(supportsPermissionMode('opencode', 'dontAsk')).toBe(true)
  })

  it('does not second-guess an adapter it has never heard of', () => {
    expect(supportsPermissionMode('some-future-adapter', 'plan')).toBe(true)
  })
})

describe('permissionModeError', () => {
  it('is null when the mode can be honoured', () => {
    expect(permissionModeError('claude', 'plan')).toBeNull()
    expect(permissionModeError('codex', 'bypassPermissions')).toBeNull()
  })

  it('names the adapter, the mode, and a way forward', () => {
    const msg = permissionModeError('cursor', 'plan')!
    expect(msg).toContain('cursor')
    expect(msg).toContain('plan')
    expect(msg).toContain('acceptEdits')
    // A refusal with no alternative is just a wall.
    expect(msg).toMatch(/claude|codex/)
  })
})
