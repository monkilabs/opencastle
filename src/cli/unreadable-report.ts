/**
 * One line per file, whatever number of readers complained about it.
 *
 * The lists in `init` and `sync` were deduplicated on `name\0why`, so a
 * `.mcp.json` that is a directory was reported by the adapter as unreadable *and*
 * by the config rebuild as invalid JSON. Both entries survived and the command
 * printed two sentences about one file, of which one was always false:
 *
 *   ! Left .mcp.json alone — it could not be read.
 *   ! Left .mcp.json alone — it is not valid JSON.
 *
 * A file we cannot open we certainly cannot parse, so "unreadable" is the truer
 * of the two and wins. Shared rather than written twice, because the two callers
 * printing the same report from separately maintained copies of the same logic is
 * the shape that produced the disagreement in the first place.
 */
/**
 * Why a file was left alone, as the end of "Left <file> alone — …".
 *
 * Each caller used to spell this itself, as "it is not valid JSON" — true of
 * every config until Codex's, which is TOML.
 */
export function whyLeftAlone(name: string, why: string | undefined): string {
  if (why === 'unreadable') return 'it could not be read.'
  if (why === 'uneditable') {
    return 'its MCP servers are written in a form this cannot change without rewriting yours — give each one its own [mcp_servers.<name>] table.'
  }
  return `it is not valid ${name.endsWith('.toml') ? 'TOML' : 'JSON'}.`
}

export function noteUnreadable(into: string[], entry: string): void {
  const SEP = '\u0000'
  const [name, why] = entry.split(SEP)
  const at = into.findIndex((e) => e.split(SEP)[0] === name)
  if (at === -1) {
    into.push(entry)
    return
  }
  if (why === 'unreadable') into[at] = entry
}
