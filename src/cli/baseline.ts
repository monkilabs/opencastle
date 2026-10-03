import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { resolveSources, materialize, cliVersionOf, hasErrors } from './layers.js'
import type { TeamIssue } from './team-config.js'
import { contentReport, tokensOf } from './lock.js'
import { CONFIG_SCHEMA_URL } from './team-config.js'
import { EXTENSION_NAMESPACE, claudeManifestFor, isAgentPlugin, mcpSchemaUrl, pluginNameFrom, pluginSchemaUrl, readAgentPlugin, type PluginManifest } from './agent-plugin.js'
import { staleClaudeFiles } from './plugin.js'
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
 *
 * A baseline `init` creates is also an Agent Plugin: `plugin.json`, skills in
 * `skills/`, portable servers in `mcp.json`, and the rest of OpenCastle's layer
 * — instructions, agents, prompts, workflows, policy — in `dev.opencastle/`.
 * Assistants that read Agent Plugins can install it as it is; OpenCastle
 * compiles all of it into every assistant for every repository that extends it.
 */

const HELP = `
  opencastle baseline <init|check> [dir] [options]

  init [dir]    Scaffold a baseline package (default: ./opencastle-baseline)
                that is also an Agent Plugin: example instructions, a skill
                and a policy, a README on publishing and adopting it, and a
                CI check.
  check [dir]   Validate a baseline the way every repository extending it
                will — its config, its content, its policy and its packaging —
                and, when it is an Agent Plugin, the way assistants load it.

  Options:
    --name <pkg>  Package name for init (default: @your-org/opencastle-baseline)
    --json        Machine-readable output for check
    --help, -h    Show this help
`

function files(name: string, cliVersion: string): Record<string, string> {
  const description = 'Our AI assistant standard: compiled by OpenCastle into every assistant in every repository that extends it, and an Agent Plugin any assistant that reads them can install.'
  const manifest: PluginManifest = {
    $schema: pluginSchemaUrl(),
    name: pluginNameFrom(name),
    version: '0.1.0',
    description,
    license: 'UNLICENSED',
  }
  return {
    'package.json':
      JSON.stringify(
        {
          name,
          version: '0.1.0',
          description,
          license: 'UNLICENSED',
          files: ['plugin.json', 'mcp.json', 'skills/', `${EXTENSION_NAMESPACE}/`, '.claude-plugin/', '.mcp.json'],
          opencastle: { baseline: '.' },
          scripts: { check: 'opencastle baseline check', build: 'opencastle plugin build' },
          devDependencies: { opencastle: `^${cliVersion}` },
          publishConfig: { access: 'restricted' },
        },
        null,
        2,
      ) + '\n',
    'plugin.json': JSON.stringify(manifest, null, 2) + '\n',
    'mcp.json': JSON.stringify({ $schema: mcpSchemaUrl(), mcpServers: {} }, null, 2) + '\n',
    '.claude-plugin/plugin.json': JSON.stringify(claudeManifestFor(manifest), null, 2) + '\n',
    [`${EXTENSION_NAMESPACE}/config.json`]: `{
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
  // Servers that need a variable — a token, a tenant — go here: write it as
  // \${NAME} and OpenCastle spells it the way each assistant expects. A server
  // every assistant can start as it is goes in ../mcp.json, where assistants
  // that install this as an Agent Plugin find it too.
  "mcpServers": {}
}
`,
    [`${EXTENSION_NAMESPACE}/instructions/engineering-standards.md`]: `# Engineering standards

These apply to every repository in the organisation, and every assistant reads
them before every task. Keep this file short: detail belongs in a skill, which
loads only when a task needs it.

- Write tests for behaviour you change, and run them before you say you are done.
- Never write credentials into files; read them from the environment.
- Keep changes small and focused; one pull request, one purpose.
`,
    'skills/code-review/SKILL.md': `---
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

Our AI assistant standard. It is two things at once:

- an [OpenCastle](https://www.opencastle.dev) baseline — every repository that
  extends it gets the same instructions, skills and MCP servers in every
  assistant its developers use (Claude Code, Cursor, Copilot, OpenCode,
  Windsurf, Codex CLI, Antigravity) and is held to the same policy;
- an [Agent Plugin](https://agent-plugins.org) — GitHub Copilot, VS Code,
  Cursor, Codex and Kiro can install its skills and MCP servers as they are,
  and Claude Code through \`.claude-plugin/\`.

## What is in it

| Path | What it is | Read by |
| --- | --- | --- |
| \`plugin.json\` | The Agent Plugins manifest | Every assistant that reads Agent Plugins |
| \`skills/<name>/SKILL.md\` | Agent Skills, loaded when a task matches | Every assistant |
| \`mcp.json\` | MCP servers every assistant can start as they are | Every assistant |
| \`${EXTENSION_NAMESPACE}/instructions/\` | Loaded by every assistant before every task | OpenCastle |
| \`${EXTENSION_NAMESPACE}/agents/\`, \`prompts/\`, \`workflows/\` | Optional | OpenCastle |
| \`${EXTENSION_NAMESPACE}/config.json\` | Servers that need variables, and the policy | OpenCastle |
| \`.claude-plugin/plugin.json\`, \`.mcp.json\` | Claude Code's copies — \`npm run build\` writes them | Claude Code |

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

1. Edit it, then run \`npm run build\` (Claude Code's copies) and
   \`npm run check\` — it validates the baseline the way every repository
   extending it will, and the plugin the way assistants load it.
2. Bump the version in package.json and plugin.json, and publish.
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
  console.log(`  ${c.dim('It is an Agent Plugin too: skills/ and mcp.json are portable; the rest of the layer is in')} ${EXTENSION_NAMESPACE}/`)
  console.log(`  ${c.dim('Next: edit it, run')} ${c.cyan(`npx opencastle baseline check ${dir}`)}${c.dim(', then publish it.')}`)
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
  let published: string[] | undefined
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
    published = pkg.files
    if (typeof pkg.opencastle?.baseline !== 'string') {
      errors.push('package.json: has no "opencastle": { "baseline": "<dir>" }, so no repository can extend it')
    } else {
      layerRoot = resolve(root, pkg.opencastle.baseline)
      const rel = relative(root, layerRoot).split('\\').join('/')
      // Consumers refuse a layer outside the package, so this must too — or
      // it would pass here and fail in every repository that extends it.
      if (rel.startsWith('..') || isAbsolute(rel)) {
        errors.push(`package.json: "opencastle.baseline" points outside the package (${pkg.opencastle.baseline}), which no repository extending it will accept`)
      }
      // `files` decides what `npm publish` ships. A baseline whose layer is not
      // in it publishes as an empty package, and every repository extending it
      // compiles nothing from it — with no error anywhere.
      if (pkg.files && rel !== '' && !pkg.files.some((f) => f.replace(/\/$/, '') === rel || rel.startsWith(f.replace(/\/$/, '') + '/'))) {
        errors.push(`package.json: "files" does not include ${rel}/, so npm publish would ship a baseline with nothing in it`)
      }
    }
  }
  if (!existsSync(layerRoot)) errors.push(`${relative(process.cwd(), layerRoot) || '.'}: the layer directory does not exist`)

  // The plugin side: what an assistant that installs it as an Agent Plugin sees.
  if (errors.length === 0 && isAgentPlugin(layerRoot)) {
    const report = readAgentPlugin(layerRoot)
    errors.push(...report.errors)
    warnings.push(...report.warnings)
    if (report.manifest) {
      for (const f of staleClaudeFiles(layerRoot, report)) {
        errors.push(`${f}: does not match plugin.json and mcp.json — run opencastle plugin build`)
      }
      if (!existsSync(join(layerRoot, '.claude-plugin', 'plugin.json'))) {
        warnings.push('.claude-plugin/plugin.json: missing — Claude Code reads only its own manifest; run opencastle plugin build')
      }
      if (version && report.manifest.version && version !== report.manifest.version) {
        warnings.push(`plugin.json: version ${report.manifest.version}, while package.json says ${version} — assistants offer updates by plugin.json's`)
      }
      // `files` decides what npm publishes; a plugin missing its manifest or
      // its skills installs as nothing.
      if (published) {
        const at = relative(root, layerRoot).split('\\').join('/')
        for (const part of ['plugin.json', 'skills', 'mcp.json', EXTENSION_NAMESPACE, '.claude-plugin', '.mcp.json']) {
          if (!existsSync(join(layerRoot, part))) continue
          const path = at ? `${at}/${part}` : part
          const shipped = published.some((f) => {
            const entry = f.replace(/\/$/, '')
            return entry === path || path.startsWith(`${entry}/`)
          })
          if (!shipped) errors.push(`package.json: "files" does not include ${path}, so npm publish would leave it out`)
        }
      }
    }
  } else if (errors.length === 0) {
    warnings.push(
      'is not an Agent Plugin, so only OpenCastle can use it — assistants that read Agent Plugins cannot install it. ' +
        '`opencastle baseline init` shows the layout: skills/ and mcp.json at the root, the rest in dev.opencastle/',
    )
  }

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
      // The scratch project names the baseline by its path from there —
      // `../../../../Users/ana/base` — and stripping the `../` left an absolute
      // path with its leading slash gone. Named instead as it was given here.
      const id = relative(project, layerRoot).split('\\').join('/') || '.'
      const here = dir === '.' ? '' : `${dir.replace(/\/$/, '')}/`
      const shown = (text: string): string =>
        text.split(`${id}/`).join(here).split(id).join(name).split(project).join('<repository>')
      // One string per problem, its remedy on the line below — not the icons
      // `formatIssues` prints, which the report below adds again.
      const said = (i: TeamIssue): string => shown(`${i.where}: ${i.message}${i.fix ? `\n→ ${i.fix}` : ''}`)
      for (const i of resolved.issues) (i.level === 'error' ? errors : warnings).push(said(i))
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
    const indent = (text: string): string => text.split('\n').join('\n    ')
    for (const e of report.errors) console.log(`  ${c.red('✗')} ${indent(e)}`)
    for (const w of report.warnings) console.log(`  ${c.yellow('!')} ${c.dim(indent(w))}`)
    console.log(report.errors.length === 0 ? `\n  ${c.green('✓')} Ready to publish.\n` : `\n  ${c.red(`${report.errors.length} problem(s) to fix before publishing.`)}\n`)
  }
  if (report.errors.length > 0) process.exit(1)
}
