import { describe, it, expect, beforeEach } from 'vitest'
import { maskSecretLine, redactSecrets, redactValue, REDACTED } from './redact.js'
import { _resetAllowlistCache, _setAllowlistConfigPath, scanForSecrets } from './gates.js'

const TOKEN = 'ghp_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9'

beforeEach(() => {
  _setAllowlistConfigPath('/nonexistent/secret-scan-config.yml')
  _resetAllowlistCache()
})

describe('maskSecretLine', () => {
  it('hides the value and keeps the words around it', () => {
    const masked = maskSecretLine(`export GITHUB_TOKEN=${TOKEN} # ci`)
    expect(masked).not.toContain(TOKEN)
    expect(masked).toContain(REDACTED)
    expect(masked).toContain('export')
    expect(scanForSecrets(masked).clean).toBe(true)
  })

  it('drops the whole line when masking tokens is not enough', () => {
    const masked = maskSecretLine('postgres://admin:hunter@db.local/app', 'Connection String')
    expect(masked).toBe(`${REDACTED} (Connection String)`)
  })
})

describe('redactSecrets', () => {
  it('leaves clean text alone', () => {
    expect(redactSecrets('nothing to see\nhere')).toEqual({ text: 'nothing to see\nhere', patterns: [] })
  })

  it('masks only the flagged lines', () => {
    const r = redactSecrets(`line one\ntoken ${TOKEN}\nline three`)
    expect(r.text.split('\n')[0]).toBe('line one')
    expect(r.text.split('\n')[2]).toBe('line three')
    expect(r.text).not.toContain(TOKEN)
    expect(r.patterns).toEqual(['GitHub Token'])
  })
})

describe('redactValue', () => {
  it('masks strings anywhere in a structure and keeps its shape', () => {
    const { value, patterns } = redactValue({ reason: `token ${TOKEN}`, n: 3, list: ['ok', `x ${TOKEN}`] })
    expect(value.n).toBe(3)
    expect(value.list[0]).toBe('ok')
    expect(JSON.stringify(value)).not.toContain(TOKEN)
    expect(patterns).toHaveLength(2)
  })
})
