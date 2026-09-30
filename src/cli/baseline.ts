import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { resolveSources, materialize, cliVersionOf, formatIssues, hasErrors } from './layers.js'
import { contentReport, tokensOf } from './lock.js'
import { CONFIG_SCHEMA_URL } from './team-config.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * `opencastle baseline`: the organisation's standard as a package.
 *
 * A baseline is an ordinary npm package that says so in its package.json. Every
 * repository adds it as a devDependency and names it in `extends`; the
 * package manager does the fetching, the lockfile does the pinning, and an
 * upgrade bot does the rollout — one pull request per repository, each with
 * `opencastle review` explaining what it changes.
 */

const HELP = `
  opencastle baseline <init|check> [dir] [options]

  init [dir]    Scaffold a baseline package (default: ./opencastle-baseline):
                a layer with example instructions, a skill and a policy,
                a README on publishing and adopting it, and a CI check.
  check [dir]   Validate a baseline the way every repository extending it
                will: its config, its content, its policy and its packaging.

  Options:
    --name <pkg>  Package name for init (default: @your-org/opencastle-baseline)
    --json        Machine-readable output for check
    --help, -h    Show this help
`

function files(name: string, cliVersion: string): Record<string, string> {
  return {
    'package.json':
      JSON.stringify(
        {
          name,
          version: '0.1.0',
          description: "Our AI assistant standard, compiled by OpenCastle into every assistant in every repository that extends it.",
          license: 'UNLICENSED',
          files: ['layer/'],
          opencastle: { baseline: 'layer' },
          scripts: { check: 'opencastle baseline check' },
          devDependencies: { opencastle: `^${cliVersion}` },
          publishConfig: { access: 'restricted' },
        },
        null,
        2,
      ) + '\n',
    'layer/config.json': `{
  "$schema": "${CONFIG_SCHEMA_URL}",
  // Every repository that extends this baseline is held to this policy.
  // A repository can tighten it in its own .opencastle/config.json, never relax it.
  "policy": {
    "mcp": {
      // The MCP servers an assistant may start. Integration servers not listed here
      // are left out of the generated config, and a hand-added one fails doctor and CI.
      "allow": ["chrome-devtools", "Playwright", "Linear", "Sentry"],
      // Remote servers may only connect to these hosts.
      "remoteHosts": ["mcp.linear.app"],
      // Every local server runs an exact version, so every laptop runs the same code.
      "requirePinned": true
    },
    // Items no repository may exclude or replace.
    "require": ["instructions/engineering-standards"],
    // Tokens every assistant may load before it reads the task.
    "contextBudget": 8000
  },
  // Servers every repository gets. Write variables as \${NAME}; OpenCastle
  // spells them the way each assistant expects.
  "mcpServers": {}
}
`,
    'layer/instructions/engineering-standards.md': `# Engineering standards

These apply to every repository in the organisation, and every assistant reads
them before every task. Keep this file short: detail belongs in a skill, which
loads only when a task needs it.

- Write tests for behaviour you change, and run them before you say you are done.
- Never write credentials into files; read them from the environment.
- Keep changes small and focused; one pull request, one purpose.
`,
    'layer/skills/code-review/SKILL.md': `---
name: code-review
description: "How we review code: what to check, what to block on, and how to word feedback. Use when reviewing a pull request or preparing one for review."
---

# Code review

Block on: correctness, security, missing tests for changed behaviour, and
anything that makes the next change harder. Comment, do not block, on style
a formatter could fix.

Word feedback as a question or a suggestion with the reason attached.
`,
    'README.md': `# ${name}

Our AI assistant standard, as an [OpenCastle](https://www.opencastle.dev) baseline.
Every repository that extends it gets the same instructions, skills and MCP
servers in every assistant its developers use — Claude Code, Cursor, Copilot,
OpenCode, Windsurf, Codex CLI and Antigravity — and is held to the same policy.

## What is in it

- \`layer/instructions/\` — loaded by every assistant before every task
- \`layer/skills/<name>/SKILL.md\` — loaded when a task matches its description
- \`layer/agents/*.agent.md\`, \`layer/prompts/\`, \`layer/workflows/\` — optional
- \`layer/config.json\` — MCP servers every repository gets, and the policy
  (allowed servers and hosts, pinning, required items, context budget)

## Adopting it in a repository

\`\`\`sh
npm i -D ${name} opencastle
\`\`\`

\`\`\`jsonc
// .opencastle/config.json
{ "extends": ["${name}"] }
\`\`\`

\`\`\`sh
npx opencastle sync     # compile it into every assistant
npx opencastle ci       # fail pull requests on drift or policy breaks
\`\`\`

The version comes from package.json and the lockfile, like any dependency.

## Changing it

1. Edit \`layer/\`, then run \`npm run check\` — it validates the baseline the way
   every repository extending it will.
2. Bump the version and publish.
3. Let your upgrade bot (Renovate, Dependabot) open the pull requests. In each,
   CI runs \`opencastle sync --check\` and adds \`opencastle review\`'s summary of
   what the new version changes for that repository's assistants.
`,
    '.github/workflows/check.yml': `name: Check baseline
on: [pull_request, push]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npx --no opencastle baseline check
`,
  }
}

async function init(pkgRoot: string, dir: string, name: string): Promise<void> {
  const root = resolve(dir)
  if (existsSync(join(root, 'package.json'))) {
    console.error(`\n  ${c.red('✗')} ${dir} already has a package.json — pick an empty directory.\n`)
    process.exit(1)
  }
  for (const [rel, text] of Object.entries(files(name, cliVersionOf(pkgRoot)))) {
    const abs = join(root, rel)
    await mkdir(resolve(abs, '..'), { recursive: true })
    await writeFile(abs, text)
  }
  console.log(`\n  ${c.green('✓')} Created the baseline ${c.bold(name)} in ${dir}/`)
  console.log(`  ${c.dim('Next: edit layer/, run')} ${c.cyan(`npx opencastle baseline check ${dir}`)}${c.dim(', then publish it.')}`)
  console.log(`  ${c.dim('Repositories adopt it with')} ${c.cyan(`npm i -D ${name}`)} ${c.dim('and')} ${c.cyan(`"extends": ["${name}"]`)}\n`)
}

interface CheckReport {
  baseline: string
  version?: string
  errors: string[]
  warnings: string[]
  contributes: { skills: number; agents: number; instructions: number; prompts: number; workflows: number; mcpServers: number }
  contextTokens: number
}

function check(pkgRoot: string, dir: string): CheckReport {
  const root = resolve(dir)
  const errors: string[] = []
  const warnings: string[] = []
  let layerRoot = root
  let name = dir
  let version: string | undefined
  const pkgFile = join(root, 'package.json')
  if (existsSync(pkgFile)) {
    let pkg: { name?: string; version?: string; files?: string[]; opencastle?: { baseline?: string } } = {}
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    } catch (err) {
      errors.push(`package.json: is not valid JSON — ${(err as Error).message}`)
    }
    name = pkg.name ?? name
    version = pkg.version
    if (typeof pkg.opencastle?.baseline !== 'string') {
      errors.push('package.json: has no "opencastle": { "baseline": "<dir>" }, so no repository can extend it')
    } else {
      layerRoot = resolve(root, pkg.opencastle.baseline)
      const rel = relative(root, layerRoot).split('\\').join('/')
      // `files` decides what `npm publish` ships. A baseline whose layer is not
      // in it publishes as an empty package, and every repository extending it
      // compiles nothing from it — with no error anywhere.
      if (pkg.files && rel !== '' && !pkg.files.some((f) => f.replace(/\/$/, '') === rel || rel.startsWith(f.replace(/\/$/, '') + '/'))) {
        errors.push(`package.json: "files" does not include ${rel}/, so npm publish would ship a baseline with nothing in it`)
      }
    }
  }
  if (!existsSync(layerRoot)) errors.push(`${relative(process.cwd(), layerRoot) || '.'}: the layer directory does not exist`)

  const contributes = { skills: 0, agents: 0, instructions: 0, prompts: 0, workflows: 0, mcpServers: 0 }
  let contextTokens = 0
  if (errors.length === 0) {
    // Resolved exactly as a repository extending it would resolve it.
    const project = mkdtempSync(join(tmpdir(), 'opencastle-baseline-check-'))
    try {
      mkdirSync(join(project, '.opencastle'), { recursive: true })
      const spec = relative(join(project, '.opencastle'), layerRoot).split('\\').join('/')
      writeFileSync(join(project, '.opencastle', 'config.json'), JSON.stringify({ extends: [spec.startsWith('.') ? spec : `./${spec}`] }))
      const resolved = resolveSources({ pkgRoot, projectRoot: project, stack: { ides: [], techTools: [], teamTools: [] } })
      const shown = (text: string): string => text.split(project).join('<repository>').replace(/(\.\.\/)+/g, '')
      for (const line of formatIssues(resolved.issues.filter((i) => i.level === 'error'))) errors.push(shown(line))
      for (const line of formatIssues(resolved.issues.filter((i) => i.level === 'warning'))) warnings.push(shown(line))
      for (const item of resolved.items.values()) {
        if (item.layer !== 'opencastle') contributes[item.kind]++
      }
      contributes.mcpServers = resolved.servers.size
      if (!hasErrors(resolved)) {
        const source = materialize(resolved, pkgRoot)
        try {
          const r = contentReport(source)
          contextTokens = tokensOf(r.instructionChars + r.indexChars)
        } finally {
          source.dispose()
        }
      }
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  }
  return { baseline: name, version, errors, warnings, contributes, contextTokens }
}

export default async function baseline({ pkgRoot, args }: CliContext): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || args.includes('--help') || args.includes('-h') || !['init', 'check'].includes(sub)) {
    console.log(HELP)
    if (sub && !['init', 'check', '--help', '-h'].includes(sub)) process.exit(1)
    return
  }
  const nameAt = rest.indexOf('--name')
  if (nameAt !== -1 && (!rest[nameAt + 1] || rest[nameAt + 1].startsWith('--'))) {
    console.error(`  ${c.red('✗')} --name needs a package name, e.g. --name @acme/opencastle-baseline`)
    process.exit(1)
  }
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(nameAt !== -1 && i === nameAt + 1))

  if (sub === 'init') {
    await init(pkgRoot, positional[0] ?? 'opencastle-baseline', nameAt !== -1 ? rest[nameAt + 1] : '@your-org/opencastle-baseline')
    return
  }

  const report = check(pkgRoot, positional[0] ?? '.')
  if (rest.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`\n  🏰 ${c.bold('Baseline')} ${report.baseline}${report.version ? c.dim(` ${report.version}`) : ''}\n`)
    const k = report.contributes
    const parts = Object.entries(k).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${kind === 'mcpServers' ? 'MCP server(s)' : kind}`)
    console.log(`  Contributes: ${parts.length > 0 ? parts.join(', ') : c.dim('nothing yet')}`)
    if (report.contextTokens) console.log(`  A repository extending it loads ~${report.contextTokens} tokens up front, with OpenCastle's own content`)
    for (const e of report.errors) console.log(`  ${c.red('✗')} ${e}`)
    for (const w of report.warnings) console.log(`  ${c.yellow('!')} ${c.dim(w)}`)
    console.log(report.errors.length === 0 ? `\n  ${c.green('✓')} Ready to publish.\n` : `\n  ${c.red(`${report.errors.length} problem(s) to fix before publishing.`)}\n`)
  }
  if (report.errors.length > 0) process.exit(1)
}
