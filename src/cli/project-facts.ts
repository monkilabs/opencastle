import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_DETECTIONS } from './detect.js'

/**
 * What a project is, read from its files: the facts `init` writes into
 * `.opencastle/` on a first install.
 *
 * The customization files used to be templates with empty tables and
 * `TODO: verify` in every version cell, waiting for an agent to fill them in —
 * and until one did, every skill that sent an agent to them sent it to nothing.
 * Most of what they ask for is in the repository already: the routes are
 * files, the API is files, the models are in the schema, the commands are in
 * package.json. Everything here is deterministic and bounded; anything that
 * needs judgement — architecture, production URLs — is left for a person or
 * `/oc:bootstrap-customizations`.
 */

export interface ProjectFacts {
  name?: string
  description?: string
  packageManager: string
  language?: string
  scripts: Record<string, string>
  /** Detected technologies with the version a package.json declares. */
  stack: Array<{ layer: string; name: string; version?: string }>
  /** Top-level directories, and `src/`'s, with what they hold when the name says. */
  dirs: Array<{ path: string; purpose: string }>
  /** Workspace packages of a monorepo, with what each is when it can be told. */
  workspaces: Array<{ path: string; name: string; purpose: string }>
  devPort?: number
  /** Each place pages live, e.g. `app/` or `apps/web/src/app/`, with their URLs. */
  pages: Array<{ root: string; routes: string[] }>
  api: Array<{ route: string; methods: string[]; file: string }>
  /** tRPC routers, for a project whose API has no route files. */
  rpcRouters: string[]
  serverActions: string[]
  middleware?: string
  models: { source: string; names: string[] } | null
  migrations: { dir: string; count: number; latest: string[] } | null
  testFrameworks: string[]
  testConfigs: string[]
  testFiles: string[]
  breakpoints: { source: string; values: Array<[string, string]> } | null
  docs: string[]
  envVars: { source: string; names: string[] } | null
  ciWorkflows: string[]
  /** The project commands the CI workflows run — the checks a change has to pass. */
  ciCommands: string[]
  /** From `engines.node`, `.nvmrc` or `.node-version`. */
  nodeVersion?: string
  /** Coverage thresholds the test config enforces, e.g. `lines 80`. */
  coverage: string[]
  /** Config files of frameworks and tools, wherever in the tree they are. */
  configPaths: string[]
  /** Files that import a package, by the detection label of the package. */
  importers: Record<string, string[]>
}

// ── Reading the tree ────────────────────────────────────────────────────────

/** Never walked into: dependencies, build output, caches, VCS, native projects. */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', '.astro',
  '.turbo', '.vercel', '.netlify', '.cache', 'coverage', '.opencastle', 'vendor', 'target', '.expo',
  'android', 'ios', 'Pods', '.venv', 'venv', '__pycache__', 'storybook-static', '.docusaurus',
])

const MAX_FILES = 10_000
const MAX_DEPTH = 10
const MAX_READ_BYTES = 200_000

/** Project files, relative and with `/`, in a stable order. Dot-directories are skipped. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue
        await walk(join(dir, e.name), path, depth + 1)
      } else if (e.isFile()) {
        out.push(path)
      }
    }
  }
  await walk(root, '', 0)
  return out
}

async function read(root: string, rel: string): Promise<string> {
  try {
    const text = await readFile(join(root, rel), 'utf8')
    return text.length > MAX_READ_BYTES ? text.slice(0, MAX_READ_BYTES) : text
  } catch {
    return ''
  }
}

interface PackageJson {
  name?: string
  description?: string
  engines?: Record<string, string>
  jest?: { coverageThreshold?: { global?: Record<string, number> } }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function readPackage(root: string, rel: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await read(root, rel)) as PackageJson
  } catch {
    return null
  }
}

// ── Directory purposes ──────────────────────────────────────────────────────

const PURPOSE: Record<string, string> = {
  apps: 'Applications', packages: 'Shared packages', libs: 'Libraries', tooling: 'Shared tooling config',
  turbo: 'Turborepo generators', components: 'UI components', ui: 'UI components', lib: 'Shared code and clients',
  utils: 'Utilities', helpers: 'Utilities', hooks: 'React hooks', styles: 'Styles', public: 'Static assets',
  static: 'Static assets', assets: 'Assets', prisma: 'Prisma schema and migrations',
  supabase: 'Supabase config and migrations', drizzle: 'Drizzle schema and migrations', db: 'Database code',
  database: 'Database code', migrations: 'Database migrations', convex: 'Convex functions and schema',
  config: 'Configuration', content: 'Content files', types: 'Shared types', test: 'Tests', tests: 'Tests',
  __tests__: 'Tests', e2e: 'End-to-end tests', cypress: 'Cypress tests', scripts: 'Scripts', docs: 'Documentation',
  server: 'Server code', api: 'API', auth: 'Authentication', validators: 'Validation schemas', services: 'Services',
  features: 'Feature modules', modules: 'Modules', layouts: 'Layouts', emails: 'Email templates',
  email: 'Email templates', locales: 'Translations', i18n: 'Translations', messages: 'Translations', store: 'State',
  stores: 'State', state: 'State', middleware: 'Middleware', routes: 'Routes', pages: 'Pages', app: 'Application',
  studio: 'CMS studio', sanity: 'Sanity Studio', actions: 'Server actions', models: 'Data models',
  schemas: 'Schemas', schema: 'Schema', infra: 'Infrastructure', terraform: 'Infrastructure (Terraform)',
  deploy: 'Deployment', bin: 'Executables', src: 'Source', fixtures: 'Test fixtures', mocks: 'Mocks',
  examples: 'Examples', data: 'Data',
}

function purposeOf(path: string, frameworks: string[]): string {
  const name = path.split('/').pop()!
  if (name === 'app' && frameworks.includes('next')) return 'Routes (App Router)'
  if (name === 'pages' && frameworks.includes('next')) return 'Routes (Pages Router)'
  if (name === 'pages' && frameworks.includes('astro')) return 'Pages and endpoints'
  if (name === 'routes' && frameworks.includes('sveltekit')) return 'Routes'
  return PURPOSE[name] ?? ''
}

/** What a workspace is, from its description, the framework it depends on, or its folder name. */
const APP_KIND: Array<[string, string]> = [
  ['next', 'Next.js app'], ['expo', 'Expo app'], ['astro', 'Astro site'], ['@sveltejs/kit', 'SvelteKit app'],
  ['nuxt', 'Nuxt app'], ['@remix-run/react', 'Remix app'], ['@tanstack/react-start', 'TanStack Start app'],
  ['@nestjs/core', 'NestJS service'], ['express', 'Express server'], ['fastify', 'Fastify server'], ['hono', 'Hono server'],
  ['vite', 'Vite app'], ['electron', 'Electron app'],
]

function workspacePurpose(path: string, pkg: PackageJson): string {
  if (pkg.description) return pkg.description
  const deps = { ...pkg.devDependencies, ...pkg.dependencies }
  for (const [dep, kind] of APP_KIND) if (deps[dep]) return kind
  return PURPOSE[path.replace(/\/$/, '').split('/').pop()!] ?? ''
}

// ── Routes ──────────────────────────────────────────────────────────────────

const HTTP = /export\s+(?:async\s+)?(?:function|const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)\b/g

function methodsIn(source: string): string[] {
  return [...new Set([...source.matchAll(HTTP)].map((m) => m[1]))]
}

/** `app/(marketing)/blog/[slug]` → `/blog/[slug]`: groups and slots are not in the URL. */
function appRoute(dir: string): string {
  const parts = dir.split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
  return '/' + parts.join('/')
}

/** A route file's path, without its extension: `blog/index` → `/blog`. */
function fileRoute(path: string): string {
  return '/' + path.replace(/(^|\/)index$/, '').replace(/^\/+/, '')
}

/** A folder or file whose name starts with `_` is not routed (Next.js, Astro). */
const PRIVATE = (path: string): boolean => path.split('/').some((s) => s.startsWith('_'))

async function findRoutes(
  root: string,
  files: string[],
  frameworks: string[],
): Promise<{ pages: ProjectFacts['pages']; api: ProjectFacts['api'] }> {
  const api: ProjectFacts['api'] = []
  const pages = new Map<string, Set<string>>()
  const page = (at: string, route: string) => {
    if (!pages.has(at)) pages.set(at, new Set())
    pages.get(at)!.add(route)
  }

  for (const path of files) {
    // In a monorepo the routes are in each app: the same rules, under its folder.
    const ws = /^((?:apps|packages|services)\/[^/]+\/)/.exec(path)?.[1] ?? ''
    const f = path.slice(ws.length)
    // Next.js App Router
    let m = /^(src\/)?app\/(?:(.*)\/)?page\.(tsx|ts|jsx|js|mdx|md)$/.exec(f)
    if (m && frameworks.includes('next')) {
      if (!PRIVATE(m[2] ?? '')) page(`${ws}${m[1] ?? ''}app/`, appRoute(m[2] ?? ''))
      continue
    }
    m = /^(src\/)?app\/(?:(.*)\/)?route\.(ts|js)$/.exec(f)
    if (m && frameworks.includes('next')) {
      if (!PRIVATE(m[2] ?? '')) api.push({ route: appRoute(m[2] ?? ''), methods: methodsIn(await read(root, path)), file: path })
      continue
    }
    // Next.js Pages Router
    m = /^(src\/)?pages\/(.+)\.(tsx|ts|jsx|js|mdx|md)$/.exec(f)
    if (m && frameworks.includes('next')) {
      if (/(^|\/)_(app|document|error)$/.test(m[2])) continue
      if (m[2].startsWith('api/')) api.push({ route: fileRoute(m[2]), methods: [], file: path })
      else page(`${ws}${m[1] ?? ''}pages/`, fileRoute(m[2]))
      continue
    }
    // Astro
    m = /^src\/pages\/(.+)\.(astro|md|mdx|html|ts|js)$/.exec(f)
    if (m && frameworks.includes('astro')) {
      if (PRIVATE(m[1])) continue
      if (m[2] === 'ts' || m[2] === 'js') api.push({ route: fileRoute(m[1]), methods: methodsIn(await read(root, path)), file: path })
      else page(`${ws}src/pages/`, fileRoute(m[1]))
      continue
    }
    // SvelteKit
    m = /^src\/routes\/(?:(.*)\/)?\+(page\.svelte|server\.(ts|js))$/.exec(f)
    if (m && frameworks.includes('sveltekit')) {
      const route = appRoute(m[1] ?? '')
      if (m[2].startsWith('server')) api.push({ route, methods: methodsIn(await read(root, path)), file: path })
      else page(`${ws}src/routes/`, route)
      continue
    }
    // Remix flat routes
    m = /^app\/routes\/([^/]+)\.(tsx|ts|jsx|js)$/.exec(f)
    if (m && frameworks.includes('remix')) {
      page(`${ws}app/routes/`, '/' + m[1].replace(/^_index$/, '').replace(/\._index$/, '').replace(/\./g, '/').replace(/\$/g, ':'))
    }
  }

  // Express, Fastify, Hono and their like: `app.get('/path', …)`.
  if (api.length === 0 && frameworks.some((f) => ['express', 'fastify', 'hono'].includes(f))) {
    const call = /\b(?:app|router|server|api|fastify)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]*)['"`]/g
    for (const f of files.filter((p) => /\.(ts|js|mjs|cjs)$/.test(p) && !/\.(test|spec)\./.test(p)).slice(0, 400)) {
      for (const hit of (await read(root, f)).matchAll(call)) {
        const existing = api.find((a) => a.route === hit[2] && a.file === f)
        if (existing) existing.methods.push(hit[1].toUpperCase())
        else api.push({ route: hit[2], methods: [hit[1].toUpperCase()], file: f })
      }
    }
  }

  api.sort((a, b) => a.route.localeCompare(b.route))
  return {
    pages: [...pages].map(([at, routes]) => ({ root: at, routes: [...routes].sort() })).sort((a, b) => a.root.localeCompare(b.root)),
    api,
  }
}

// ── Data ────────────────────────────────────────────────────────────────────

async function findModels(root: string, files: string[]): Promise<ProjectFacts['models']> {
  const prisma = files.filter((f) => f.endsWith('.prisma'))
  if (prisma.length) {
    const names = (await Promise.all(prisma.map((f) => read(root, f))))
      .flatMap((s) => [...s.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]))
    return { source: prisma.length === 1 ? prisma[0] : `${prisma.length} .prisma files`, names }
  }
  const convex = files.find((f) => /(^|\/)convex\/schema\.ts$/.test(f))
  if (convex) {
    const names = [...(await read(root, convex)).matchAll(/(\w+)\s*:\s*defineTable\(/g)].map((m) => m[1])
    return { source: convex, names }
  }
  const drizzle: string[] = []
  let drizzleSource = ''
  const candidates = files.filter((p) => /\.(ts|js)$/.test(p) && (/schema/i.test(p.split('/').pop()!) || /(^|\/)(db|drizzle|schema)\//.test(p)))
  for (const f of candidates.slice(0, 80)) {
    const names = [...(await read(root, f)).matchAll(/(?:pgTable|mysqlTable|sqliteTable)\(\s*['"]([\w-]+)['"]/g)].map((m) => m[1])
    if (names.length) {
      drizzle.push(...names)
      drizzleSource ||= f
    }
  }
  if (drizzle.length) return { source: drizzleSource, names: [...new Set(drizzle)] }
  const sql = files.filter((f) => /(^|\/)supabase\/migrations\/.+\.sql$/.test(f))
  if (sql.length) {
    const names = (await Promise.all(sql.map((f) => read(root, f))))
      .flatMap((s) => [...s.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)].map((m) => m[1]))
    return { source: 'supabase/migrations/', names: [...new Set(names)] }
  }
  return null
}

function findMigrations(files: string[]): ProjectFacts['migrations'] {
  for (const dir of ['prisma/migrations', 'supabase/migrations', 'drizzle', 'migrations', 'db/migrations']) {
    const within = files.filter((f) => new RegExp(`(^|/)${dir}/`).test(f) && f.endsWith('.sql'))
    if (within.length === 0) continue
    const base = within[0].slice(0, within[0].indexOf(`${dir}/`) + dir.length + 1)
    const entries = [...new Set(within.map((f) => f.slice(base.length).split('/')[0]))].sort()
    return { dir: base, count: entries.length, latest: entries.slice(-3) }
  }
  return null
}

// ── Everything else ─────────────────────────────────────────────────────────

const TEST_PACKAGES: Record<string, string> = {
  vitest: 'Vitest', jest: 'Jest', '@playwright/test': 'Playwright', cypress: 'Cypress', mocha: 'Mocha', ava: 'AVA',
}

const DEFAULT_PORT: Array<[string, number]> = [
  ['next', 3000], ['nuxt', 3000], ['astro', 4321], ['sveltekit', 5173], ['remix', 5173], ['expo', 8081],
]

function devPortOf(scripts: Record<string, string>, frameworks: string[], deps: Record<string, string>): number | undefined {
  const dev = scripts.dev ?? scripts.start ?? ''
  const explicit = /(?:-p|--port)[ =](\d{2,5})\b|\bPORT=(\d{2,5})\b/.exec(dev)
  if (explicit) return Number(explicit[1] ?? explicit[2])
  for (const [fw, port] of DEFAULT_PORT) if (frameworks.includes(fw)) return port
  if (deps.vite && /\bvite\b/.test(dev)) return 5173
  return undefined
}

const TAILWIND_DEFAULTS: Array<[string, string]> = [['sm', '640px'], ['md', '768px'], ['lg', '1024px'], ['xl', '1280px'], ['2xl', '1536px']]

async function findBreakpoints(root: string, files: string[], usesTailwind: boolean): Promise<ProjectFacts['breakpoints']> {
  if (!usesTailwind) return null
  const config = files.find((f) => /(^|\/)tailwind\.config\.(js|ts|mjs|cjs)$/.test(f))
  const values = new Map(TAILWIND_DEFAULTS)
  let source = config ?? 'Tailwind defaults'
  if (config) {
    const text = await read(root, config)
    for (const m of text.matchAll(/screens\s*:\s*\{([^}]*)\}/g)) {
      // `container: { screens: … }` sizes the container, not the breakpoints.
      if (/container\s*:\s*\{[^}]*$/.test(text.slice(Math.max(0, m.index - 300), m.index))) continue
      for (const [, name, value] of m[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"](\d+(?:\.\d+)?(?:px|rem|em))['"]/g)) values.set(name, value)
    }
  }
  // Tailwind 4 declares them in CSS.
  for (const css of files.filter((f) => f.endsWith('.css')).slice(0, 40)) {
    const text = await read(root, css)
    if (!text.includes('@theme')) continue
    const declared = [...text.matchAll(/--breakpoint-([\w-]+)\s*:\s*([\d.]+(?:px|rem|em))/g)]
    for (const [, name, value] of declared) values.set(name, value)
    if (declared.length) source = css
  }
  return { source, values: [...values] }
}

async function findEnvVars(root: string, files: string[]): Promise<ProjectFacts['envVars']> {
  // Example files and validated env schemas only. A real `.env` holds secrets
  // and is never read.
  const example = ['.env.example', '.env.sample', '.env.template', '.env.local.example'].find((f) => existsSync(join(root, f)))
  if (example) {
    const names = [...(await read(root, example)).matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1])
    if (names.length) return { source: example, names: [...new Set(names)] }
  }
  const schema = files.find((f) => /(^|\/)(src\/)?env\.(mjs|js|ts)$/.test(f))
  if (schema) {
    const names = [...(await read(root, schema)).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1])
    if (names.length) return { source: schema, names: [...new Set(names)] }
  }
  return null
}

/**
 * The files that import each detected package, best first, at most three: the
 * one that sets the client up — `lib/db.ts`, `lib/stripe.ts` — before the
 * pages that use it.
 */
async function findImporters(root: string, files: string[], packages: Map<string, string>): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {}
  if (packages.size === 0) return found
  const code = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|astro|svelte|vue)$/.test(f) && !/\.(test|spec|d)\./.test(f)).slice(0, 1500)
  const patterns = [...packages].map(([pkg, label]) => {
    const quoted = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    return { label, re: new RegExp(`(?:from|require\\(|import\\()\\s*['"]${quoted}(?:/[^'"]*)?['"]`) }
  })
  for (const f of code) {
    const text = await read(root, f)
    for (const { label, re } of patterns) if (re.test(text)) (found[label] ??= []).push(f)
  }
  const score = (f: string, label: string): number => {
    const base = f.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase()
    return (base.includes(label.split('-')[0]) || ['db', 'client', 'prisma', 'auth'].includes(base) ? 0 : 10) +
      (/(^|\/)(lib|server|db|utils|services)\//.test(f) ? 0 : 5) +
      f.split('/').length
  }
  const out: Record<string, string[]> = {}
  for (const [label, list] of Object.entries(found)) {
    out[label] = [...list].sort((a, b) => score(a, label) - score(b, label) || a.localeCompare(b)).slice(0, 3)
  }
  return out
}

/** The packages behind a detection label. Frameworks are left out: every file imports them. */
function packagesFor(labels: string[]): Map<string, string> {
  const wanted = new Set(labels)
  const map = new Map<string, string>()
  for (const [pkg, { category, label }] of Object.entries(PACKAGE_DETECTIONS)) {
    if (category === 'frameworks' || category === 'styling' || category === 'testing') continue
    if (wanted.has(label)) map.set(pkg, label)
  }
  return map
}

const CONFIG_FILE =
  /(^|\/)((next|astro|nuxt|svelte|vite|remix|tailwind|drizzle|sanity|playwright|vitest|jest|cypress|metro)\.config\.[cm]?[jt]s|app\.json|app\.config\.[jt]s|vercel\.json|netlify\.toml|turbo\.json|nx\.json|wrangler\.(toml|jsonc?)|Dockerfile|(docker-)?compose\.ya?ml|fly\.toml|render\.yaml)$/

const LAYERS: Array<[string, string]> = [
  ['frameworks', 'Framework'], ['databases', 'Database'], ['cms', 'CMS'], ['auth', 'Auth'],
  ['styling', 'Styling'], ['testing', 'Testing'], ['services', 'Service'],
]

const DISPLAY: Record<string, string> = {
  next: 'Next.js', nuxt: 'Nuxt', astro: 'Astro', remix: 'Remix', sveltekit: 'SvelteKit', express: 'Express',
  fastify: 'Fastify', hono: 'Hono', expo: 'Expo', vite: 'Vite', prisma: 'Prisma', drizzle: 'Drizzle',
  supabase: 'Supabase', convex: 'Convex', mongoose: 'Mongoose', typeorm: 'TypeORM', sanity: 'Sanity',
  contentful: 'Contentful', strapi: 'Strapi', payload: 'Payload', 'next-auth': 'NextAuth.js', clerk: 'Clerk',
  auth0: 'Auth0', lucia: 'Lucia', passport: 'Passport', tailwind: 'Tailwind CSS', sass: 'Sass',
  'styled-components': 'styled-components', emotion: 'Emotion', 'css-modules': 'CSS Modules', jest: 'Jest',
  vitest: 'Vitest', playwright: 'Playwright', cypress: 'Cypress', stripe: 'Stripe', resend: 'Resend',
  sentry: 'Sentry', notion: 'Notion', vercel: 'Vercel', netlify: 'Netlify', cloudflare: 'Cloudflare',
  docker: 'Docker', railway: 'Railway', fly: 'Fly.io', render: 'Render', 'github-actions': 'GitHub Actions',
  'gitlab-ci': 'GitLab CI', circleci: 'CircleCI', jenkins: 'Jenkins', turborepo: 'Turborepo', nx: 'Nx',
}

export function displayName(label: string): string {
  return DISPLAY[label] ?? label
}

/** `^13.4.0` → `13.4.0`; a range or tag that is not a version is kept as written. */
function cleanVersion(range: string | undefined): string | undefined {
  if (!range || /^(workspace|catalog|link|file):/.test(range)) return undefined
  const m = /^[\^~>=<\s]*(\d[\w.+-]*)/.exec(range)
  return m ? m[1] : range
}

/** pnpm's `catalog:` versions, from pnpm-workspace.yaml: the default catalog and named ones. */
async function readCatalog(root: string): Promise<Map<string, string>> {
  const text = await read(root, 'pnpm-workspace.yaml')
  const catalog = new Map<string, string>()
  let inCatalog = false
  for (const line of text.split('\n')) {
    if (/^catalogs?:\s*$/.test(line)) {
      inCatalog = true
      continue
    }
    if (/^\S/.test(line)) inCatalog = false
    if (!inCatalog) continue
    const m = /^\s+['"]?(@?[\w./-]+)['"]?\s*:\s*['"]?([^'"#\s]+)/.exec(line)
    if (m && /\d/.test(m[2]) && !catalog.has(m[1])) catalog.set(m[1], m[2])
  }
  return catalog
}

export interface DetectedStack {
  packageManager?: string
  language?: string
  frameworks?: string[]
  databases?: string[]
  cms?: string[]
  auth?: string[]
  styling?: string[]
  testing?: string[]
  services?: string[]
}

/**
 * The commands CI runs that a developer could run too: lines of a workflow's
 * `run:` that call the package manager or a project script.
 */
async function findCiCommands(root: string, workflows: string[], pm: string): Promise<string[]> {
  const out: string[] = []
  const runner = new RegExp(`^(?:${pm}|npm|pnpm|yarn|bun|npx|node)\\b`)
  for (const wf of workflows) {
    const lines = (await read(root, wf)).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)-?\s*run:\s*(.*)$/.exec(lines[i])
      if (!m) continue
      const cmds: string[] = []
      if (/^[|>]-?\s*$/.test(m[2])) {
        const indent = m[1].length
        for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j++) cmds.push(lines[j].trim())
      } else cmds.push(m[2].trim())
      for (const c of cmds) if (runner.test(c) && !/\binstall\b|\bci$|\bci\s/.test(c) && !out.includes(c)) out.push(c)
    }
  }
  return out.slice(0, 8)
}

async function findCoverage(root: string, configs: string[], pkg: PackageJson): Promise<string[]> {
  const fromJest = pkg.jest?.coverageThreshold?.global
  if (fromJest) return Object.entries(fromJest).map(([k, v]) => `${k} ${v}`)
  for (const f of configs.filter((c) => /(vitest|jest)\.config/.test(c))) {
    const text = await read(root, f)
    const block = /(?:thresholds|coverageThreshold)\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1]
    if (!block) continue
    const values = [...block.matchAll(/\b(lines|branches|functions|statements)\s*:\s*(\d+)/g)].map((m) => `${m[1]} ${m[2]}`)
    if (values.length) return values
  }
  return []
}

/** The README's opening paragraph, when it is a sentence or two that says what the project is. */
async function readmeSummary(root: string, files: string[]): Promise<string | undefined> {
  const readme = files.find((f) => /^readme\.mdx?$/i.test(f))
  if (!readme) return undefined
  const text = (await read(root, readme)).replace(/<!--[\s\S]*?-->/g, '')
  // Only what comes before the first section: an introduction, not instructions.
  const intro = text.split(/\n#{2,}\s/)[0]
  const first = intro
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|!\[|\[!\[|<|>|```|\||-|\*|\d+\.)/.test(p))
  if (!first || /:\s*$/.test(first)) return undefined
  const sentence = first.replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  return sentence.length <= 300 ? sentence : undefined
}

/**
 * Read the facts. `detected` is what `detectRepoInfo` found in the files —
 * not the integrations someone selected, which name tools like Chrome DevTools
 * that the project itself does not use.
 */
export async function readProjectFacts(root: string, detected: DetectedStack): Promise<ProjectFacts> {
  const pkg = (await readPackage(root, 'package.json')) ?? {}
  const files = await listFiles(root)
  const frameworks = detected.frameworks ?? []

  // Every package.json of a monorepo declares versions; the root often none.
  const workspaceManifests = files.filter((f) => /^(apps|packages|libs|services|tooling)\/[^/]+\/package\.json$/.test(f))
  const workspacePkgs = await Promise.all(workspaceManifests.map(async (f) => ({ f, pkg: (await readPackage(root, f)) ?? {} })))
  const catalog = await readCatalog(root)
  const deps: Record<string, string> = {}
  for (const p of [pkg, ...workspacePkgs.map((w) => w.pkg)]) {
    for (const [name, range] of Object.entries({ ...p.devDependencies, ...p.dependencies })) {
      const resolved = /^catalog:/.test(range) ? catalog.get(name) ?? range : range
      if (!deps[name] || (cleanVersion(resolved) && !cleanVersion(deps[name]))) deps[name] = resolved
    }
  }

  const versionOf = (label: string): string | undefined => {
    for (const [name, rule] of Object.entries(PACKAGE_DETECTIONS)) {
      if (rule.label === label && deps[name]) return cleanVersion(deps[name])
    }
    return cleanVersion(deps[label])
  }
  const stack: ProjectFacts['stack'] = []
  for (const [key, layer] of LAYERS) {
    for (const label of (detected as Record<string, string[] | undefined>)[key] ?? []) {
      stack.push({ layer, name: displayName(label), version: versionOf(label) })
    }
  }

  const top = await readdir(root, { withFileTypes: true }).catch(() => [])
  const dirs: ProjectFacts['dirs'] = []
  for (const e of top.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    dirs.push({ path: `${e.name}/`, purpose: purposeOf(e.name, frameworks) })
    if (e.name === 'src') {
      const inner = await readdir(join(root, 'src'), { withFileTypes: true }).catch(() => [])
      for (const s of inner.filter((d) => d.isDirectory() && !d.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
        dirs.push({ path: `src/${s.name}/`, purpose: purposeOf(s.name, frameworks) })
      }
    }
  }

  const { pages, api } = await findRoutes(root, files, frameworks)

  const rpcRouters: string[] = []
  if (deps['@trpc/server']) {
    for (const f of files.filter((p) => /\.(ts|tsx)$/.test(p) && !/\.(test|spec|d)\./.test(p)).slice(0, 1500)) {
      if (/createTRPCRouter\(|\bt\.router\(|\brouter\(\s*\{/.test(await read(root, f))) rpcRouters.push(f)
      if (rpcRouters.length >= 20) break
    }
  }

  const actionCandidates = files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && /(^|\/)(src\/)?(app|lib|actions|server)\//.test(f)).slice(0, 800)
  const serverActions: string[] = []
  for (const f of actionCandidates) {
    if (/^\s*['"]use server['"]/m.test((await read(root, f)).slice(0, 400))) serverActions.push(f)
  }

  const testFrameworks = Object.entries(TEST_PACKAGES).filter(([p]) => deps[p]).map(([, name]) => name)
  const testFiles = files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(__tests__|e2e|cypress\/e2e)\//.test(f))
  const testConfigs = files.filter((f) => /(^|\/)(vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s$/.test(f))

  const ciWorkflows = (await readdir(join(root, '.github', 'workflows')).catch(() => []))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `.github/workflows/${f}`)
  const nodeFile = ((await read(root, '.nvmrc')) || (await read(root, '.node-version'))).trim()
  const nodeVersion = pkg.engines?.node ?? (nodeFile || undefined)

  const docs = files.filter((f) =>
    /^(README|CONTRIBUTING|ARCHITECTURE|CHANGELOG|DEVELOPMENT|SECURITY)\.mdx?$/i.test(f) || /^docs\/[^/]+\.mdx?$/.test(f),
  ).slice(0, 15)

  return {
    name: pkg.name,
    description: pkg.description ?? (await readmeSummary(root, files)),
    packageManager: detected.packageManager ?? 'npm',
    language: detected.language,
    scripts: pkg.scripts ?? {},
    stack,
    dirs,
    workspaces: workspacePkgs
      .filter(({ f }) => /^(apps|packages|libs|services)\//.test(f))
      .map(({ f, pkg: w }) => {
        const path = f.replace(/package\.json$/, '')
        return { path, name: w.name ?? path, purpose: workspacePurpose(path, w) }
      }),
    devPort: devPortOf(pkg.scripts ?? {}, frameworks, deps),
    pages,
    api,
    rpcRouters,
    serverActions,
    middleware: files.find((f) => /^((apps|packages)\/[^/]+\/)?(src\/)?middleware\.(ts|js)$/.test(f)),
    models: await findModels(root, files),
    migrations: findMigrations(files),
    testFrameworks,
    testConfigs,
    testFiles,
    breakpoints: await findBreakpoints(root, files, (detected.styling ?? []).includes('tailwind')),
    docs,
    envVars: await findEnvVars(root, files),
    ciWorkflows,
    ciCommands: await findCiCommands(root, ciWorkflows, detected.packageManager ?? 'npm'),
    nodeVersion,
    coverage: await findCoverage(root, testConfigs, pkg),
    configPaths: files.filter((f) => CONFIG_FILE.test(f)),
    importers: await findImporters(root, files, packagesFor([
      ...(detected.databases ?? []), ...(detected.cms ?? []), ...(detected.auth ?? []), ...(detected.services ?? []),
    ])),
  }
}
