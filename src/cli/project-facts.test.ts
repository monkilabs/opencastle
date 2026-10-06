import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readProjectFacts } from './project-facts.js'

/**
 * The facts `init` writes into `.opencastle/`, read from small project trees
 * shaped like the real ones they stand for.
 */

let root = ''

function project(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'oc-facts-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

const pkg = (body: object): string => JSON.stringify(body)

describe('routes', () => {
  it('reads Next.js App Router pages and route handlers, without groups, slots or private folders', async () => {
    const r = project({
      'package.json': pkg({ dependencies: { next: '^15.1.0' } }),
      'app/page.tsx': '',
      'app/(marketing)/pricing/page.tsx': '',
      'app/blog/[slug]/page.mdx': '',
      'app/@modal/login/page.tsx': '',
      'app/_components/card/page.tsx': '',
      'app/api/posts/route.ts': 'export async function GET() {}\nexport const POST = handler',
      'pages/api/legacy.ts': 'export default function handler() {}',
    })
    const facts = await readProjectFacts(r, { frameworks: ['next'] })
    expect(facts.pages).toEqual([{ root: 'app/', routes: ['/', '/blog/[slug]', '/login', '/pricing'] }])
    expect(facts.api).toEqual([
      { route: '/api/legacy', methods: [], file: 'pages/api/legacy.ts' },
      { route: '/api/posts', methods: ['GET', 'POST'], file: 'app/api/posts/route.ts' },
    ])
    expect(facts.stack).toEqual([{ layer: 'Framework', name: 'Next.js', version: '15.1.0' }])
    expect(facts.devPort).toBe(3000)
  })

  it('leaves out Astro files whose path has a part starting with an underscore', async () => {
    const r = project({
      'package.json': pkg({ dependencies: { astro: '5.0.0' } }),
      'src/pages/index.astro': '',
      'src/pages/posts/[slug].astro': '',
      'src/pages/posts/_components/Card.astro': '',
      'src/pages/_utils/group.ts': 'export function group() {}',
      'src/pages/rss.xml.ts': 'export const GET = () => new Response()',
    })
    const facts = await readProjectFacts(r, { frameworks: ['astro'] })
    expect(facts.pages[0].routes).toEqual(['/', '/posts/[slug]'])
    expect(facts.api.map((a) => [a.route, a.methods])).toEqual([['/rss.xml', ['GET']]])
  })

  it('reads SvelteKit pages and server routes', async () => {
    const r = project({
      'package.json': pkg({}),
      'src/routes/+page.svelte': '',
      'src/routes/about/+page.svelte': '',
      'src/routes/api/items/+server.ts': 'export async function GET() {}\nexport async function DELETE() {}',
    })
    const facts = await readProjectFacts(r, { frameworks: ['sveltekit'] })
    expect(facts.pages[0]).toEqual({ root: 'src/routes/', routes: ['/', '/about'] })
    expect(facts.api).toEqual([{ route: '/api/items', methods: ['GET', 'DELETE'], file: 'src/routes/api/items/+server.ts' }])
  })

  it('finds routes in each app of a monorepo', async () => {
    const r = project({
      'package.json': pkg({ name: 'mono' }),
      'apps/web/package.json': pkg({ name: '@x/web', dependencies: { next: '15.0.0' } }),
      'apps/web/src/app/page.tsx': '',
      'apps/web/src/app/settings/page.tsx': '',
    })
    const facts = await readProjectFacts(r, { frameworks: ['next'] })
    expect(facts.pages).toEqual([{ root: 'apps/web/src/app/', routes: ['/', '/settings'] }])
    expect(facts.workspaces).toEqual([{ path: 'apps/web/', name: '@x/web', purpose: 'Next.js app' }])
  })

  it('reads Express-style routes when there are no route files', async () => {
    const r = project({
      'package.json': pkg({ dependencies: { express: '4.19.0' } }),
      'src/server.js': "app.get('/health', h)\napp.post('/notes', h)\nrouter.delete('/notes/:id', h)",
    })
    const facts = await readProjectFacts(r, { frameworks: ['express'] })
    expect(facts.api.map((a) => `${a.methods.join(',')} ${a.route}`)).toEqual(['GET /health', 'POST /notes', 'DELETE /notes/:id'])
  })
})

describe('data', () => {
  it('lists Prisma models and its migrations', async () => {
    const r = project({
      'package.json': pkg({ dependencies: { '@prisma/client': '^5.2.0' } }),
      'prisma/schema.prisma': 'model User {\n  id Int @id\n}\n\nmodel Post {\n  id Int @id\n}\nenum Role { A }\n',
      'prisma/migrations/20240101_init/migration.sql': '',
      'prisma/migrations/20240202_posts/migration.sql': '',
      'lib/db.ts': "import { PrismaClient } from '@prisma/client'",
      'app/page.tsx': "import type { User } from '@prisma/client'",
    })
    const facts = await readProjectFacts(r, { databases: ['prisma'] })
    expect(facts.models).toEqual({ source: 'prisma/schema.prisma', names: ['User', 'Post'] })
    expect(facts.migrations).toEqual({ dir: 'prisma/migrations/', count: 2, latest: ['20240101_init', '20240202_posts'] })
    // The file that sets the client up comes before the pages that use it.
    expect(facts.importers.prisma[0]).toBe('lib/db.ts')
  })

  it('lists Drizzle tables from every schema file', async () => {
    const r = project({
      'package.json': pkg({}),
      'packages/db/src/schema.ts': 'export const Post = pgTable("post", {})',
      'packages/db/src/auth-schema.ts': 'export const user = pgTable("user", {})\nexport const session = pgTable("session", {})',
    })
    const facts = await readProjectFacts(r, { databases: ['drizzle'] })
    expect(facts.models?.names.sort()).toEqual(['post', 'session', 'user'])
  })

  it('lists Supabase tables from its migrations', async () => {
    const r = project({
      'package.json': pkg({}),
      'supabase/migrations/20240101000000_init.sql': 'create table public.profiles (id uuid);\nCREATE TABLE IF NOT EXISTS "orders" ();',
    })
    const facts = await readProjectFacts(r, { databases: ['supabase'] })
    expect(facts.models).toEqual({ source: 'supabase/migrations/', names: ['profiles', 'orders'] })
  })
})

describe('everything else', () => {
  it('takes variable names from the example file and never reads .env', async () => {
    const r = project({
      'package.json': pkg({}),
      '.env': 'SECRET_ONLY_IN_ENV=hunter2\n',
      '.env.example': 'DATABASE_URL=\nexport STRIPE_KEY=sk_test\n# COMMENTED=1\n',
    })
    const facts = await readProjectFacts(r, {})
    expect(facts.envVars).toEqual({ source: '.env.example', names: ['DATABASE_URL', 'STRIPE_KEY'] })
    expect(JSON.stringify(facts)).not.toContain('SECRET_ONLY_IN_ENV')
    expect(JSON.stringify(facts)).not.toContain('hunter2')
  })

  it('reads Tailwind breakpoints, but not the container sizes', async () => {
    const r = project({
      'package.json': pkg({}),
      'tailwind.config.js': 'module.exports = { theme: { container: { screens: { "2xl": "1400px" } }, extend: { screens: { "3xl": "1920px" } } } }',
    })
    const facts = await readProjectFacts(r, { styling: ['tailwind'] })
    const values = Object.fromEntries(facts.breakpoints!.values)
    expect(values['2xl']).toBe('1536px')
    expect(values['3xl']).toBe('1920px')
  })

  it('resolves pnpm catalog versions from a workspace package', async () => {
    const r = project({
      'package.json': pkg({ name: 'mono' }),
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\ncatalog:\n  next: ^16.0.1\n  "@prisma/client": 6.1.0\n',
      'apps/web/package.json': pkg({ dependencies: { next: 'catalog:', '@prisma/client': 'catalog:' } }),
    })
    const facts = await readProjectFacts(r, { frameworks: ['next'], databases: ['prisma'] })
    expect(facts.stack).toEqual([
      { layer: 'Framework', name: 'Next.js', version: '16.0.1' },
      { layer: 'Database', name: 'Prisma', version: '6.1.0' },
    ])
  })

  it('describes the project from the README introduction only', async () => {
    const intro = project({
      'package.json': pkg({ name: 'x' }),
      'README.md': '# X\n\n[![ci](https://x/badge.svg)](https://x)\n\nX turns [notes](https://n) into tasks.\n\n## Install\n\nRun this:\n',
    })
    expect((await readProjectFacts(intro, {})).description).toBe('X turns notes into tasks.')
    rmSync(intro, { recursive: true, force: true })

    const howTo = project({
      'package.json': pkg({ name: 'y' }),
      'README.md': '# Y\n\nThere are two ways to start:\n\n## Setup\n\nY is great.\n',
    })
    expect((await readProjectFacts(howTo, {})).description).toBeUndefined()
  })

  it('takes a port from the dev script before the framework default', async () => {
    const r = project({ 'package.json': pkg({ scripts: { dev: 'next dev -p 4000' } }) })
    expect((await readProjectFacts(r, { frameworks: ['next'] })).devPort).toBe(4000)
  })

  it('reads what CI runs, the Node version and the coverage the tests require', async () => {
    const r = project({
      'package.json': pkg({ engines: { node: '>=20' }, devDependencies: { vitest: '2.0.0' } }),
      '.github/workflows/ci.yml': [
        'jobs:',
        '  test:',
        '    steps:',
        '      - run: pnpm install --frozen-lockfile',
        '      - run: pnpm lint',
        '      - name: Test',
        '        run: |',
        '          pnpm test --coverage',
        '          echo done',
      ].join('\n'),
      'vitest.config.ts': 'export default { test: { coverage: { thresholds: { lines: 80, branches: 70 } } } }',
    })
    const facts = await readProjectFacts(r, { packageManager: 'pnpm' })
    expect(facts.ciCommands).toEqual(['pnpm lint', 'pnpm test --coverage'])
    expect(facts.nodeVersion).toBe('>=20')
    expect(facts.coverage).toEqual(['lines 80', 'branches 70'])
  })

  it('names test frameworks from package.json only, and finds the test files', async () => {
    const r = project({
      'package.json': pkg({ devDependencies: { vitest: '^2.0.0' } }),
      'vitest.config.ts': '',
      'src/a.test.ts': '',
      'e2e/login.spec.ts': '',
    })
    const facts = await readProjectFacts(r, { testing: ['vitest', 'chrome-devtools'] })
    expect(facts.testFrameworks).toEqual(['Vitest'])
    expect(facts.testConfigs).toEqual(['vitest.config.ts'])
    expect(facts.testFiles.sort()).toEqual(['e2e/login.spec.ts', 'src/a.test.ts'])
  })
})

describe('Python and Go projects', () => {
  const FASTAPI = {
    'pyproject.toml': `[tool.poetry]\nname = "conduit"\n\n[tool.poetry.dependencies]\npython = "^3.9"\nfastapi = "^0.79.1"\nalembic = "^1.8"\n\n[tool.poetry.dev-dependencies]\npytest = "^7.1"\nmypy = "^0.971"\n`,
    'poetry.lock': '',
    'app/api/routes/api.py': 'from fastapi import APIRouter\nfrom app.api.routes import users, articles\nrouter = APIRouter()\nrouter.include_router(users.router, tags=["users"], prefix="/users")\nrouter.include_router(\n    articles.router,\n    dependencies=[Depends(auth)],\n)\n',
    'app/api/routes/users.py': 'router = APIRouter()\n\n@router.post("/login")\nasync def login(): ...\n\n@router.get("")\nasync def me(): ...\n',
    'app/api/routes/articles/api.py': 'router = APIRouter()\nrouter.include_router(resource.router, prefix="/articles")\n',
    'app/api/routes/articles/resource.py': 'router = APIRouter()\n\n@router.get("/{slug}")\nasync def one(): ...\n',
    'app/db/migrations/versions/fdf8821871d7_main_tables.py': '',
    'app/models/tables.py': 'class User(Base):\n    pass\n',
    'tests/test_users.py': '',
    'scripts/test': '#!/usr/bin/env bash\nset -e\npytest --cov=app\n',
    '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - run: poetry install\n      - run: poetry run pip --version >/dev/null 2>&1 || rm -rf .venv\n      - run: poetry run uvicorn app.main:app &\n      - run: poetry run ./scripts/test\n',
  }

  it('reads a FastAPI service: no npm, its versions, its commands, and routes with the prefixes they are mounted at', async () => {
    const facts = await readProjectFacts(project(FASTAPI), { language: 'python', frameworks: ['fastapi'] })
    expect(facts.packageManager).toBe('poetry')
    expect(facts.language).toBe('python')
    expect(facts.stack).toEqual(expect.arrayContaining([
      { layer: 'Language', name: 'Python', version: '3.9' },
      { layer: 'Framework', name: 'FastAPI', version: '0.79.1' },
      { layer: 'Database', name: 'Alembic', version: '1.8' },
      { layer: 'Testing', name: 'pytest', version: '7.1' },
    ]))
    expect(facts.api.map((a) => `${a.methods[0]} ${a.route}`).sort()).toEqual(['GET /articles/{slug}', 'GET /users', 'POST /users/login'])
    expect(facts.commands.map((c) => c.cmd)).toEqual(['./scripts/test', 'poetry install', 'poetry run pytest', 'poetry run mypy .'])
    expect(facts.commands[0].does).toBe('pytest --cov=app')
    expect(facts.testFrameworks).toEqual(['pytest'])
    expect(facts.testFiles).toEqual(['tests/test_users.py'])
    expect(facts.migrations).toMatchObject({ count: 1, latest: ['fdf8821871d7_main_tables'] })
    expect(facts.models).toEqual({ source: 'SQLAlchemy', names: ['User'] })
    // The check a change has to pass, not the job's plumbing.
    expect(facts.ciCommands).toEqual(['poetry run ./scripts/test'])
  })

  it('reads Flask and Django routes, and requirements files', async () => {
    const facts = await readProjectFacts(project({
      'requirements.txt': 'Flask==3.0.2\nDjango>=5.0\n',
      'app/views.py': '@app.route("/health", methods=["GET", "POST"])\ndef health(): ...\n',
      'shop/urls.py': 'urlpatterns = [path("orders/", views.orders)]\n',
    }), { language: 'python', frameworks: ['django', 'flask'] })
    expect(facts.packageManager).toBe('pip')
    expect(facts.api.map((a) => `${a.methods.join(',')} ${a.route}`).sort()).toEqual(['ANY /orders/', 'GET,POST /health'])
    expect(facts.commands.map((c) => c.cmd)).toEqual(['pip install -r requirements.txt'])
  })

  it('reads a Go service: its version, its modules, its routes, and go test', async () => {
    const facts = await readProjectFacts(project({
      'go.mod': 'module example.com/api\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgorm.io/gorm v1.25.12\n)\n',
      'users/routers.go': 'func Register(r *gin.RouterGroup) {\n\tr.POST("/login", Login)\n\tr.GET("/:id", One)\n}\n',
      'main.go': 'http.HandleFunc("GET /healthz", health)\n',
      'users/users_test.go': '',
      'Makefile': '.PHONY: run\nrun:\n\tgo run .\n',
    }), { language: 'go', frameworks: ['gin'] })
    expect(facts.packageManager).toBe('go')
    expect(facts.stack).toEqual(expect.arrayContaining([
      { layer: 'Language', name: 'Go', version: '1.22' },
      { layer: 'Framework', name: 'Gin', version: '1.10.0' },
      { layer: 'Database', name: 'GORM', version: '1.25.12' },
    ]))
    expect(facts.api.map((a) => `${a.methods[0]} ${a.route}`).sort()).toEqual(['GET /:id', 'GET /healthz', 'POST /login'])
    expect(facts.commands.map((c) => c.cmd)).toEqual(['make run', 'go build ./...', 'go test ./...', 'go vet ./...'])
    expect(facts.testFrameworks).toEqual(['go test'])
  })

  it('leaves a JavaScript project as it was: npm only where there is a package.json', async () => {
    const facts = await readProjectFacts(project({ 'README.md': '# x\n' }), {})
    expect(facts.packageManager).toBe('')
    expect(facts.commands).toEqual([])
    const withPkg = await readProjectFacts(project({ 'package.json': pkg({ scripts: { test: 'vitest' } }) }), {})
    expect(withPkg.packageManager).toBe('npm')
  })
})
