#!/usr/bin/env node
import { buildPluginPackage } from '../src/cli/package.js'
import { PLATFORM_CONFIGS } from '../src/cli/package-config.js'

const pkgRoot = new URL('../', import.meta.url).pathname.replace(/\/$/, '')
const outputBase = process.argv[2] ?? 'dist/plugins'

console.log('Building OpenCastle plugins into ' + outputBase + '...')

const results: Array<{ platform: string; skillCount: number; agentCount: number; outputDir: string }> = []
const errors: Array<{ platform: string; error: string }> = []

for (const platform of Object.keys(PLATFORM_CONFIGS)) {
  try {
    process.stdout.write('  Building ' + platform + '...')
    const result = buildPluginPackage(pkgRoot, platform, outputBase)
    results.push(result)
    console.log(' ✓ ' + result.skillCount + ' skills, ' + result.agentCount + ' agents')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push({ platform, error: msg })
    console.log(' ✗ ' + msg)
  }
}

console.log('')
if (errors.length > 0) {
  console.error('Failed platforms:')
  for (const e of errors) console.error('  ' + e.platform + ': ' + e.error)
  process.exit(1)
}

console.log('Done: ' + results.length + ' plugin packages built in ' + outputBase)
for (const r of results) {
  console.log('  ' + r.platform + ' → ' + r.outputDir)
}
