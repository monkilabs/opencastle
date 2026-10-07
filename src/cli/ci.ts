import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { readManifest } from './manifest.js'
import { cliVersionOf, resolveSources } from './layers.js'
import { resolveStack } from './stack-config.js'
import { LOCK_REL } from './lock.js'
import { TEAM_CONFIG_REL } from './team-config.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * `opencastle ci`: the checks a team needs, in the team's CI, in one command.
 *
 * `sync --check` has always been the gate; wiring it up was left to each team,
 * and most never did — which is how generated config drifts. This writes a
 * workflow that installs the project's dependencies (baselines come from
 * there), runs the project's own OpenCastle version, fails on drift, and on a
 * pull request writes what the change does to the assistants beside it. With
 * `--owners`, CODEOWNERS routes every change the lock records — instructions,
 * skills, agents, prompts, MCP servers, policy — to the people who own it.
 * Lessons are not in the lock, and the comment it writes says so.
 */

const HELP = `
  npx opencastle ci [options]

  Write a GitHub Actions workflow that fails a pull request when generated
  assistant config differs from its sources or breaks the team's policy, and
  adds a summary of what the change does to every assistant.

  Options:
    --owners <team>  Also route changes to .opencastle/lock.json and
                     .opencastle/config.json to these reviewers in CODEOWNERS
                     (e.g. @acme/platform)
    --force          Replace an existing workflow file
    --dry-run        Print what would be written, and write nothing
    --help, -h       Show this help
`

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * The repository's root, spelled the way the project's path is.
 *
 * `--show-toplevel` follows links, so on macOS a project under `/var/…` had a
 * root under `/private/var/…`: every path compared against the project's own
 * spelling fell outside the repository, a baseline kept beside the project was
 * left out of the workflow's paths, and the CODEOWNERS found was named by a
 * path the user never typed. `--show-cdup` is the way up from the project,
 * applied to the project's own path.
 */
function repoRootOf(projectRoot: string): string {
  const up = git(projectRoot, ['rev-parse', '--show-cdup'])
  return up === null ? projectRoot : resolve(projectRoot, up || '.')
}

function packageManagerOf(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  return 'npm'
}

interface Plan {
  workflowPath: string
  workflow: string
  codeowners?: { path: string; block: string }
  pinned: boolean
}

/** The lockfile lives at the project, or — in a workspace — above it. */
function findUp(start: string, names: string[], stop: string): string | null {
  let dir = start
  for (;;) {
    if (names.some((n) => existsSync(join(dir, n)))) return dir
    if (dir === stop) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * `extraPaths`: directories outside the project the check depends on — a
 * baseline kept elsewhere in the repository, whose change must run it too.
 */
/**
 * How to run OpenCastle in this project from a workflow or a hook. The
 * project's own copy when it has one: then every laptop and CI run the version
 * its lockfile pins, and nobody's global install decides the output. Otherwise
 * the release that compiled the project.
 */
export function opencastleRunner(projectRoot: string, cliVersion: string, pm?: PackageManager): string {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {}
  try {
    pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  } catch {
    pkg = {}
  }
  if (!(pkg.devDependencies?.opencastle ?? pkg.dependencies?.opencastle)) return `npx -y opencastle@${cliVersion}`
  const manager = pm ?? (() => {
    const root = findUp(projectRoot, ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'], repoRootOf(projectRoot))
    return root ? packageManagerOf(root) : 'npm'
  })()
  return manager === 'pnpm' ? 'pnpm exec opencastle' : manager === 'yarn' ? 'yarn opencastle' : 'npx --no opencastle'
}

export function planCi(projectRoot: string, cliVersion: string, owners?: string, extraPaths: string[] = []): Plan {
  const repoRoot = repoRootOf(projectRoot)
  const prefix = (git(projectRoot, ['rev-parse', '--show-prefix']) ?? '').replace(/\/$/, '')
  const branch = (git(projectRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) ?? 'origin/main').replace(/^origin\//, '')

  const installRoot =
    findUp(projectRoot, ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'], repoRoot) ??
    (existsSync(join(projectRoot, 'package.json')) ? projectRoot : null)
  const pm = installRoot ? packageManagerOf(installRoot) : 'npm'

  const run = opencastleRunner(projectRoot, cliVersion, pm)
  const pinned = !run.startsWith('npx -y ')

  const install: string[] = []
  let installRel = ''
  if (installRoot) {
    installRel = installRoot === repoRoot ? '' : installRoot.slice(repoRoot.length + 1).split('\\').join('/')
    // Always explicit in a subdirectory project: the job's default directory is
    // the project, and a lockfile at the repository root installs from there —
    // `npm ci` in a subdirectory that is not a workspace finds no lockfile.
    const at = prefix || installRel ? `\n        working-directory: ${installRel || '.'}` : ''
    // The workspace root's `packageManager`, or the project's own.
    let manager = ''
    for (const dir of [installRoot, projectRoot]) {
      try {
        manager = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { packageManager?: string }).packageManager ?? ''
      } catch {
        manager = ''
      }
      if (manager) break
    }
    if (pm === 'pnpm') {
      // The action needs a version, from `packageManager` or here.
      install.push('      - uses: pnpm/action-setup@v4')
      if (!manager.startsWith('pnpm@')) install.push('        with:', '          version: 10  # match the pnpm your lockfile was written with')
      install.push(`      - run: pnpm install --frozen-lockfile${at}`)
    } else if (pm === 'yarn') {
      // Yarn 1 ignores --immutable; --frozen-lockfile is its spelling.
      const classic = !manager.startsWith('yarn@') || manager.startsWith('yarn@1')
      install.push('      - run: corepack enable', `      - run: yarn install ${classic ? '--frozen-lockfile' : '--immutable'}${at}`)
    } else if (pm === 'bun') {
      install.push('      - uses: oven-sh/setup-bun@v2', `      - run: bun install --frozen-lockfile${at}`)
    } else {
      install.push(`      - run: ${existsSync(join(installRoot, 'package-lock.json')) ? 'npm ci' : 'npm install'}${at}`)
    }
  }

  const name = prefix ? `opencastle-${basename(prefix)}` : 'opencastle'
  const workflowPath = join(repoRoot, '.github', 'workflows', `${name}.yml`)
  // A subdirectory project runs only when something it depends on changes:
  // its own files, the lockfile a baseline upgrade moves, and this workflow.
  const paths = prefix
    ? [
        `${prefix}/**`,
        ...(installRel !== prefix ? [installRel ? `${installRel}/package.json` : 'package.json'] : []),
        ...['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
          .filter((f) => installRoot && existsSync(join(installRoot, f)))
          .map((f) => (installRel ? `${installRel}/${f}` : f)),
        ...extraPaths.map((p) => `${p}/**`),
        `.github/workflows/${name}.yml`,
      ]
    : []
  const pathFilter = paths.length > 0 ? [`    paths: [${[...new Set(paths)].map((p) => `'${p}'`).join(', ')}]`] : []
  const lines = [
    '# Written by `npx opencastle ci`. Fails a pull request when the AI assistant config',
    "# every developer gets differs from its sources or breaks the team's policy,",
    '# and summarises what the change does to the assistants.',
    `name: AI assistant config${prefix ? ` (${prefix})` : ''}`,
    '',
    'on:',
    '  pull_request:',
    ...pathFilter,
    '  push:',
    `    branches: [${branch}]`,
    ...pathFilter,
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  opencastle:',
    '    runs-on: ubuntu-latest',
    ...(prefix ? ['    defaults:', '      run:', `        working-directory: ${prefix}`] : []),
    '    steps:',
    '      # Pin actions to a commit SHA if your organisation requires it.',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    ...install,
    '      - name: Generated config matches its sources and policy',
    `        run: ${run} sync --check`,
    '      - name: What this pull request changes',
    "        if: github.event_name == 'pull_request'",
    `        run: ${run} review --base origin/\${{ github.base_ref }}`,
    '',
  ]

  const plan: Plan = { workflowPath, workflow: lines.join('\n'), pinned }
  if (owners) {
    const at = prefix ? `/${prefix}/` : '/'
    // GitHub reads the first CODEOWNERS it finds — .github/, then the root,
    // then docs/ — and ignores the rest. Creating .github/CODEOWNERS beside an
    // existing one would switch every other ownership rule off.
    const existing = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].map((p) => join(repoRoot, p)).find((p) => existsSync(p))
    plan.codeowners = {
      path: existing ?? join(repoRoot, '.github', 'CODEOWNERS'),
      block: [
        '',
        '# What every AI assistant is given (npx opencastle ci). A change to its instructions,',
        '# skills, agents, prompts, MCP servers or policy moves the lock, so these two',
        '# lines route all of them to the owners. Lessons (.opencastle/lessons/) do not.',
        `${at}${LOCK_REL} ${owners}`,
        `${at}${TEAM_CONFIG_REL} ${owners}`,
        '',
      ].join('\n'),
    }
  }
  return plan
}

export default async function ci({ pkgRoot, args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }
  const projectRoot = process.cwd()
  const ownersAt = args.indexOf('--owners')
  const owners = ownersAt !== -1 ? args[ownersAt + 1] : undefined
  if (ownersAt !== -1 && (!owners || owners.startsWith('--'))) {
    console.error(`  ${c.red('✗')} --owners needs a team or user, e.g. --owners @acme/platform`)
    process.exit(1)
  }
  if (!(await readManifest(projectRoot))) {
    console.error(`\n  ${c.red('✗')} OpenCastle is not set up here — run npx opencastle init first.\n`)
    process.exit(1)
  }

  const manifest = await readManifest(projectRoot)
  const manifestVersion = manifest?.version
  // Baselines kept elsewhere in this repository: a change there must run the check.
  const repoRoot = repoRootOf(projectRoot)
  const extra: string[] = []
  try {
    const resolved = resolveSources({ pkgRoot, projectRoot, stack: resolveStack(manifest!), repoInfo: manifest?.repoInfo })
    for (const l of resolved.layers) {
      if (l.kind !== 'baseline' || l.root.includes(`${sep}node_modules${sep}`)) continue
      const rel = relative(repoRoot, l.root)
      if (rel && !rel.startsWith('..') && relative(projectRoot, l.root).startsWith('..')) extra.push(rel.split(sep).join('/'))
    }
  } catch {
    // The workflow is still right without them; sync --check will name the problem.
  }
  const plan = planCi(projectRoot, manifestVersion ?? cliVersionOf(pkgRoot), owners, extra)
  const rel = (p: string): string => relative(repoRoot, p).split(sep).join('/')

  if (args.includes('--dry-run')) {
    console.log(`\n  ${c.dim(`[dry-run] ${rel(plan.workflowPath)}:`)}\n`)
    console.log(plan.workflow.split('\n').map((l) => `    ${l}`).join('\n'))
    if (plan.codeowners) {
      console.log(`  ${c.dim(`[dry-run] appended to ${rel(plan.codeowners.path)}:`)}`)
      console.log(plan.codeowners.block.split('\n').map((l) => `    ${l}`).join('\n'))
    }
    console.log(`  ${c.dim('No files were written.')}\n`)
    return
  }

  // Running it again is not a mistake: the same workflow already there is
  // done, not a conflict, and exiting 1 on it failed a setup script on its
  // second run. Only a different file of that name needs a decision.
  const current = existsSync(plan.workflowPath) ? readFileSync(plan.workflowPath, 'utf8') : null
  if (current === plan.workflow) {
    console.log(`\n  ${c.green('✓')} ${rel(plan.workflowPath)} is already this workflow`)
  } else if (current !== null && !args.includes('--force')) {
    console.error(`\n  ${c.red('✗')} ${rel(plan.workflowPath)} already exists and differs from the one OpenCastle writes.`)
    console.error(`    ${c.dim('Compare them with --dry-run, then pass --force to replace it.')}\n`)
    process.exit(1)
  } else {
    await mkdir(dirname(plan.workflowPath), { recursive: true })
    await writeFile(plan.workflowPath, plan.workflow)
    console.log(`\n  ${c.green('✓')} Wrote ${rel(plan.workflowPath)}`)
  }

  if (plan.codeowners) {
    const existing = existsSync(plan.codeowners.path) ? readFileSync(plan.codeowners.path, 'utf8') : ''
    const lockLine = plan.codeowners.block.split('\n').find((l) => l.includes(LOCK_REL)) ?? ''
    if (existing.includes(lockLine.split(' ')[0])) {
      console.log(`  ${c.dim(`${rel(plan.codeowners.path)} already routes ${LOCK_REL}; left as it is`)}`)
    } else {
      await mkdir(dirname(plan.codeowners.path), { recursive: true })
      await appendFile(plan.codeowners.path, plan.codeowners.block)
      console.log(`  ${c.green('✓')} Added ${owners} as owners of the lock and the team config in ${rel(plan.codeowners.path)}`)
    }
  }
  if (!plan.pinned) {
    console.log(
      `  ${c.yellow('!')} ${c.dim('OpenCastle is not in devDependencies, so CI pins the version that compiled this project.')}`,
    )
    console.log(`    ${c.dim('Add it (npm i -D opencastle) so laptops and CI run one version, then re-run with --force.')}`)
  }
  console.log(`  ${c.dim('Commit it; the next pull request gets the check and a summary of what it changes.')}\n`)
}
