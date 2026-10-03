#!/usr/bin/env node
/**
 * Write each integration's plugin.json and mcp.json from its config.ts.
 * `src/orchestrator/plugins/agent-plugins.test.ts` fails until this has run.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGINS } from '../src/orchestrator/plugins/index.js'
import { packFiles } from '../src/cli/pack-plugins.js'

const root = new URL('../src/orchestrator/plugins/', import.meta.url).pathname
let written = 0
for (const plugin of Object.values(PLUGINS)) {
  const dir = join(root, plugin.id)
  const files = packFiles(plugin)
  for (const [rel, text] of Object.entries(files)) {
    writeFileSync(join(dir, rel), text)
    written++
  }
  // A server that can no longer be written portably takes its mcp.json with it.
  if (!files['mcp.json'] && existsSync(join(dir, 'mcp.json'))) rmSync(join(dir, 'mcp.json'))
}
console.log(`Wrote ${written} file(s) for ${Object.keys(PLUGINS).length} integrations`)
