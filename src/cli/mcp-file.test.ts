import { describe, it, expect } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { parseMcpConfigText, serialiseMcpConfig, TomlEditError } from './mcp-file.js'

/**
 * `.codex/config.toml` holds a user's whole Codex setup — model, approvals,
 * sandbox, profiles — beside the MCP servers OpenCastle writes. These pin the
 * promise the JSON configs already keep: our servers change, nothing of theirs
 * does, byte for byte.
 */

const REL = '.codex/config.toml'

const USERS_OWN = `# My Codex setup
model = "gpt-5-codex"
approval_policy = "on-request"

[profiles.fast]
model = "gpt-5-codex-mini" # quick tasks

[mcp_servers.mine]
command = "my-server"
args = ["--port", "1234"]

[mcp_servers.mine.tools.dangerous]
approval_mode = "approve"
`

function serversOf(text: string): Record<string, unknown> {
  return (parseToml(text) as { mcp_servers?: Record<string, unknown> }).mcp_servers ?? {}
}

describe('Codex config.toml', () => {
  it('parses to a plain object with mcp_servers as the container', () => {
    const parsed = parseMcpConfigText(USERS_OWN, REL)
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.keys(parsed.mcp_servers as object)).toEqual(['mine'])
  })

  it('adds a server after the user’s content and changes nothing of theirs', () => {
    const value = parseMcpConfigText(USERS_OWN, REL)
    ;(value.mcp_servers as Record<string, unknown>).Linear = { url: 'https://mcp.linear.app/mcp' }
    const text = serialiseMcpConfig(USERS_OWN, value, REL)
    expect(text.startsWith(USERS_OWN)).toBe(true)
    expect(text.slice(USERS_OWN.length)).toBe('\n[mcp_servers.Linear]\nurl = "https://mcp.linear.app/mcp"\n')
  })

  it('removes only the server it was asked to, with its sub-tables', () => {
    const withOurs = USERS_OWN + '\n[mcp_servers.Sanity]\ncommand = "npx"\nargs = ["-y", "@sanity/mcp-server@1.2.3"]\n'
    const value = parseMcpConfigText(withOurs, REL)
    delete (value.mcp_servers as Record<string, unknown>).Sanity
    expect(serialiseMcpConfig(withOurs, value, REL)).toBe(USERS_OWN)
  })

  it('gives the user their file back byte for byte after an add and a remove', () => {
    const value = parseMcpConfigText(USERS_OWN, REL)
    ;(value.mcp_servers as Record<string, unknown>).Linear = { url: 'https://mcp.linear.app/mcp' }
    const added = serialiseMcpConfig(USERS_OWN, value, REL)
    const back = parseMcpConfigText(added, REL)
    delete (back.mcp_servers as Record<string, unknown>).Linear
    expect(serialiseMcpConfig(added, back, REL)).toBe(USERS_OWN)
  })

  it('rewrites a changed server in place and keeps the tables around it', () => {
    const before =
      'model = "x"\n\n[mcp_servers.Sentry]\nurl = "https://old.example/mcp"\n\n[profiles.a]\nmodel = "y"\n'
    const value = parseMcpConfigText(before, REL)
    ;(value.mcp_servers as Record<string, Record<string, unknown>>).Sentry = { url: 'https://mcp.sentry.dev/mcp' }
    const text = serialiseMcpConfig(before, value, REL)
    expect(text).toBe('model = "x"\n\n[mcp_servers.Sentry]\nurl = "https://mcp.sentry.dev/mcp"\n\n[profiles.a]\nmodel = "y"\n')
  })

  it('quotes a server name that is not a bare key', () => {
    const value = { mcp_servers: { 'Chrome DevTools': { command: 'npx', args: ['chrome-devtools-mcp@0.1.0'] } } }
    const text = serialiseMcpConfig(null, value, REL)
    expect(text).toContain('[mcp_servers."Chrome DevTools"]')
    expect(serversOf(text)).toEqual(value.mcp_servers)
  })

  it('writes env, env_vars and headers as values Codex reads back the same', () => {
    const entry = {
      url: 'https://api.example.com/mcp',
      bearer_token_env_var: 'EXAMPLE_TOKEN',
      http_headers: { 'X-Tenant': 'acme' },
      env_http_headers: { 'X-Key': 'EXAMPLE_KEY' },
    }
    const stdio = { command: 'npx', args: ['-y', 'x@1.0.0'], env: { MODE: 'ci "quoted"\\path' }, env_vars: ['API_TOKEN'] }
    const value = { mcp_servers: { remote: entry, local: stdio } }
    const text = serialiseMcpConfig(null, value, REL)
    expect(serversOf(text)).toEqual(value.mcp_servers)
  })

  it('keeps CRLF line endings', () => {
    const before = USERS_OWN.replace(/\n/g, '\r\n')
    const value = parseMcpConfigText(before, REL)
    ;(value.mcp_servers as Record<string, unknown>).Linear = { url: 'https://mcp.linear.app/mcp' }
    const text = serialiseMcpConfig(before, value, REL)
    expect(text.startsWith(before)).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('does not mistake a header-like line inside a multi-line string for a table', () => {
    const before = 'instructions = """\n[mcp_servers.fake]\nnot a table\n"""\n\n[mcp_servers.real]\ncommand = "a"\n'
    const value = parseMcpConfigText(before, REL)
    ;(value.mcp_servers as Record<string, Record<string, unknown>>).real = { command: 'b' }
    const text = serialiseMcpConfig(before, value, REL)
    expect(text).toContain('[mcp_servers.fake]\nnot a table')
    expect(serversOf(text)).toEqual({ real: { command: 'b' } })
  })

  it('refuses rather than rewrites servers written as inline tables', () => {
    const before = '[mcp_servers]\nmine = { command = "a" }\n'
    const value = parseMcpConfigText(before, REL)
    ;(value.mcp_servers as Record<string, Record<string, unknown>>).mine = { command: 'b' }
    expect(() => serialiseMcpConfig(before, value, REL)).toThrow(TomlEditError)
  })

  it('refuses to change anything outside [mcp_servers]', () => {
    const value = parseMcpConfigText(USERS_OWN, REL)
    value.model = 'something-else'
    expect(() => serialiseMcpConfig(USERS_OWN, value, REL)).toThrow(TomlEditError)
  })

  it('leaves no [mcp_servers] residue when the last of ours goes', () => {
    const before = 'model = "x"\n\n[mcp_servers.Linear]\nurl = "https://mcp.linear.app/mcp"\n'
    const value = parseMcpConfigText(before, REL)
    delete value.mcp_servers
    expect(serialiseMcpConfig(before, value, REL)).toBe('model = "x"\n')
  })
})

describe('JSON configs are untouched by the TOML path', () => {
  it('keeps the file’s indentation', () => {
    const before = '{\n\t"mcpServers": {}\n}\n'
    const text = serialiseMcpConfig(before, { mcpServers: { a: { command: 'x' } } }, '.mcp.json')
    expect(text).toBe('{\n\t"mcpServers": {\n\t\t"a": {\n\t\t\t"command": "x"\n\t\t}\n\t}\n}\n')
  })
})
