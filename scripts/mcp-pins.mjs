#!/usr/bin/env node
/* global console, process */
/**
 * Check, and optionally bump, the MCP server versions OpenCastle pins.
 *
 *   node scripts/mcp-pins.mjs          report: every pin exists, and which are behind
 *   node scripts/mcp-pins.mjs --bump   move every pin to the registry's latest
 *
 * Why this exists: the defaults used to say `@latest`, and three named packages
 * that were not on npm at all. One of those had been published and then pulled,
 * so its name was free for anyone to register — and every install would have run
 * whatever they published, on its next start. Pinning closes that; this script
 * keeps pins from rotting, and the weekly workflow runs it so a pin that
 * disappears from the registry turns a check red instead of breaking users.
 *
 * `--bump` records each replaced config under `previousMcpConfigs`, which is how
 * `opencastle sync` recognises an entry it wrote and may move forward. Without
 * that record an existing install would keep the old pin forever.
 *
 * Needs network access to the npm registry. Not part of `npm test`.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(root, 'src', 'orchestrator', 'plugins')
const bump = process.argv.includes('--bump')

/** The current config block: two-space indent, so a previous entry never matches. */
const CURRENT_BLOCK = /\n {2}mcpConfig: \{\n([\s\S]*?)\n {2}\},\n/
/** A quoted `name@x.y.z` spec inside it. */
const PINNED_SPEC = /'((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)'/

function npmView(spec, field) {
  try {
    const out = execFileSync('npm', ['view', spec, field, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim() ? JSON.parse(out) : null
  } catch {
    return null
  }
}

const pins = []
for (const id of readdirSync(pluginsDir).sort()) {
  const file = join(pluginsDir, id, 'config.ts')
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  const block = CURRENT_BLOCK.exec(text)
  if (!block) continue
  const spec = PINNED_SPEC.exec(block[1])
  if (!spec) continue
  pins.push({ id, file, text, block, name: spec[1], version: spec[2] })
}

let missing = 0
let behind = 0
for (const pin of pins) {
  const exists = npmView(`${pin.name}@${pin.version}`, 'version')
  const latest = npmView(pin.name, 'version')
  if (!exists) {
    missing++
    console.log(`  ✗ ${pin.id}: ${pin.name}@${pin.version} is not on the registry${latest ? ` (latest is ${latest})` : ' — the package itself is gone'}`)
    continue
  }
  if (latest && latest !== pin.version) {
    behind++
    console.log(`  ↑ ${pin.id}: ${pin.name}@${pin.version} → ${latest}`)
    if (bump) {
      const oldBlock = pin.block[1]
      const newBlock = oldBlock.replace(`'${pin.name}@${pin.version}'`, `'${pin.name}@${latest}'`)
      const previous =
        '    {\n      mcpConfig: {\n' +
        oldBlock.split('\n').map((l) => (l.trim() ? `    ${l}` : l)).join('\n') +
        '\n      },\n    },\n'
      let text = pin.text.replace(pin.block[0], pin.block[0].replace(oldBlock, newBlock))
      if (text.includes('  previousMcpConfigs: [\n')) {
        text = text.replace('  previousMcpConfigs: [\n', `  previousMcpConfigs: [\n${previous}`)
      } else {
        const end = text.lastIndexOf('};')
        text = `${text.slice(0, end)}  previousMcpConfigs: [\n${previous}  ],\n${text.slice(end)}`
      }
      writeFileSync(pin.file, text)
    }
  } else {
    console.log(`  ✓ ${pin.id}: ${pin.name}@${pin.version}`)
  }
}

console.log(
  `\n  ${pins.length} pinned server(s): ${missing} missing, ${behind} behind${bump && behind ? ' (bumped — run npm test)' : ''}\n`,
)
process.exit(missing > 0 ? 1 : 0)
