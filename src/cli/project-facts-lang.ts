/**
 * What can be read from a Python or Go project, and the commands any project
 * declares outside package.json.
 *
 * The facts were read from package.json alone, so a FastAPI service got
 * "package manager npm", no commands, no routes and "no test files" for its
 * thirteen. Everything here is read from files, never run, and left out when
 * it is not found.
 */
import type { ProjectFacts } from './project-facts.js'

type Read = (rel: string) => Promise<string>

export interface LanguageFacts {
  language: 'python' | 'go'
  /** What installs and runs the project: poetry, uv, pdm, pipenv, pip — or go. */
  tool: string
  /** Rows for the Tech Stack table: the language, and the libraries that matter. */
  stack: ProjectFacts['stack']
  /** Version of each framework label `detect` records, e.g. `fastapi` → `0.110`. */
  versions: Map<string, string>
  api: ProjectFacts['api']
  testFrameworks: string[]
  testFiles: string[]
  migrations: ProjectFacts['migrations']
  models: ProjectFacts['models']
}

// ── Python ──────────────────────────────────────────────────────────────────

/** Python packages worth a row, by their name on PyPI. */
const PYTHON_PACKAGES: Record<string, { layer: string; name: string; label?: string }> = {
  fastapi: { layer: 'Framework', name: 'FastAPI', label: 'fastapi' },
  django: { layer: 'Framework', name: 'Django', label: 'django' },
  flask: { layer: 'Framework', name: 'Flask', label: 'flask' },
  starlette: { layer: 'Framework', name: 'Starlette' },
  sqlalchemy: { layer: 'Database', name: 'SQLAlchemy' },
  sqlmodel: { layer: 'Database', name: 'SQLModel' },
  alembic: { layer: 'Database', name: 'Alembic' },
  'psycopg': { layer: 'Database', name: 'psycopg' },
  'psycopg2-binary': { layer: 'Database', name: 'psycopg2' },
  asyncpg: { layer: 'Database', name: 'asyncpg' },
  pydantic: { layer: 'Library', name: 'Pydantic' },
  celery: { layer: 'Jobs', name: 'Celery' },
  uvicorn: { layer: 'Server', name: 'Uvicorn' },
  gunicorn: { layer: 'Server', name: 'Gunicorn' },
  pytest: { layer: 'Testing', name: 'pytest' },
  ruff: { layer: 'Tooling', name: 'Ruff' },
  mypy: { layer: 'Tooling', name: 'mypy' },
}

/** `>=0.110,<1` → `0.110`; `^2.0` → `2.0`. */
function version(spec: string | undefined): string | undefined {
  return spec?.match(/\d+(?:\.\d+){0,2}/)?.[0]
}

/** Dependencies a pyproject.toml, requirements file or Pipfile declares, by lower-cased name. */
function pythonDeps(pyproject: string, requirements: string): Map<string, string> {
  const deps = new Map<string, string>()
  const add = (name: string, spec: string): void => {
    const key = name.toLowerCase().replace(/_/g, '-')
    if (!deps.has(key) || (!deps.get(key) && spec)) deps.set(key, spec)
  }
  // PEP 621 and dependency groups: quoted requirement strings inside arrays.
  for (const block of pyproject.matchAll(/^\s*[\w-]+\s*=\s*\[([\s\S]*?)\]/gm)) {
    for (const m of block[1].matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([^"';]*)/g)) add(m[1], m[2])
  }
  // Poetry: `name = "^1.2"` or `name = { version = "^1.2", … }` under a dependencies table.
  for (const table of pyproject.matchAll(/^\[tool\.poetry\.(?:[\w.-]*\.)?(?:dev-)?dependencies\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
    for (const m of table[1].matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*?version\s*=\s*"([^"]*)")/gm)) add(m[1], m[2] ?? m[3] ?? '')
  }
  for (const m of requirements.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([<>=!~][^#\n;]*)?/gm)) add(m[1], m[2] ?? '')
  return deps
}

function pythonTool(files: Set<string>, pyproject: string): string {
  if (files.has('uv.lock')) return 'uv'
  if (files.has('poetry.lock') || /^\[tool\.poetry\]/m.test(pyproject)) return 'poetry'
  if (files.has('pdm.lock')) return 'pdm'
  if (files.has('Pipfile') || files.has('Pipfile.lock')) return 'pipenv'
  return 'pip'
}

/** The argument text of each `name(` call, to its matching parenthesis. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = []
  for (let at = text.indexOf(`${name}(`); at !== -1; at = text.indexOf(`${name}(`, at + 1)) {
    let depth = 0
    for (let i = at + name.length; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')' && --depth === 0) {
        out.push(text.slice(at + name.length + 1, i))
        break
      }
    }
  }
  return out
}

const prefixIn = (args: string): string => /prefix\s*=\s*["']([^"']*)["']/.exec(args)?.[1] ?? ''

/**
 * `@router.get("/users/{id}")`, `@app.route("/", methods=["POST"])`, and
 * Django's `path("users/", …)`.
 *
 * A FastAPI route is declared relative to its router, and the router mounted
 * under a prefix somewhere else — `include_router(users.router, prefix="/users")`
 * — so each file's prefix is followed up the includes; read alone, seven
 * routes in a row were `/`.
 */
async function pythonRoutes(read: Read, files: string[]): Promise<ProjectFacts['api']> {
  const sources = files.filter((f) => f.endsWith('.py') && !/(^|\/)(tests?|migrations)\//.test(f) && !/(^|\/)test_[^/]*\.py$/.test(f))
  type Seen = { routes: Array<{ path: string; methods: string[] }>; own: string; includes: Array<{ name: string; prefix: string }> }
  const seen = new Map<string, Seen>()
  for (const f of sources.slice(0, 1500)) {
    const text = await read(f)
    if (!/@\w+\.(get|post|put|patch|delete|head|options|route)\(|include_router\(|\bpath\(|\bre_path\(/.test(text)) continue
    const routes: Seen['routes'] = []
    for (const m of text.matchAll(/@\w+\.(get|post|put|patch|delete|head|options)\(\s*["']([^"']*)["']/g)) routes.push({ path: m[2], methods: [m[1].toUpperCase()] })
    for (const m of text.matchAll(/@\w+\.route\(\s*["']([^"']+)["']([^)]*)\)/g)) {
      const methods = [...(/methods\s*=\s*[[(]([^\])]*)/.exec(m[2])?.[1] ?? '"GET"').matchAll(/["'](\w+)["']/g)].map((x) => x[1].toUpperCase())
      routes.push({ path: m[1], methods })
    }
    if (/(^|\/)urls\.py$/.test(f)) {
      for (const m of text.matchAll(/\b(?:re_)?path\(\s*r?["']([^"']*)["']/g)) routes.push({ path: `/${m[1]}`, methods: ['ANY'] })
    }
    const own = callArgs(text, 'APIRouter').map(prefixIn).find(Boolean) ?? ''
    const includes = callArgs(text, 'include_router').map((args) => ({
      name: (/^\s*([\w.]+)/.exec(args)?.[1] ?? '').replace(/\.router$/, '').split('.').pop() ?? '',
      prefix: prefixIn(args),
    }))
    seen.set(f, { routes, own, includes })
  }
  // The file an included name points at: `users` beside the including file, or
  // a package of that name with its router in `api.py` or `__init__.py`.
  const target = (from: string, name: string): string | undefined => {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    return [`${dir}${name}.py`, `${dir}${name}/api.py`, `${dir}${name}/__init__.py`, `${dir}${name}/router.py`].find((c) => seen.has(c))
  }
  const mountedAt = new Map<string, string>()
  const included = new Set<string>()
  for (const [f, s] of seen) for (const inc of s.includes) {
    const t = target(f, inc.name)
    if (t) included.add(t)
  }
  const mount = (f: string, prefix: string, depth: number): void => {
    if (depth > 8 || mountedAt.has(f)) return
    const s = seen.get(f)!
    mountedAt.set(f, prefix + s.own)
    for (const inc of s.includes) {
      const t = target(f, inc.name)
      if (t) mount(t, prefix + s.own + inc.prefix, depth + 1)
    }
  }
  for (const f of seen.keys()) if (!included.has(f)) mount(f, '', 0)
  const api: ProjectFacts['api'] = []
  for (const [f, s] of seen) {
    for (const r of s.routes) api.push({ route: `${mountedAt.get(f) ?? s.own}${r.path}`.replace(/\/{2,}/g, '/') || '/', methods: r.methods, file: f })
    if (api.length >= 80) break
  }
  return api
}

async function pythonModels(read: Read, files: string[]): Promise<ProjectFacts['models']> {
  const names: string[] = []
  let source = ''
  for (const f of files.filter((p) => p.endsWith('.py') && /(^|\/)(models?|db|schemas?|tables?|entities)(\/|\.py$)/.test(p)).slice(0, 300)) {
    const text = await read(f)
    for (const m of text.matchAll(/^class\s+(\w+)\(\s*(models\.Model|Base|db\.Model|DeclarativeBase|SQLModel[^)]*table\s*=\s*True)/gm)) {
      names.push(m[1])
      source ||= m[2].startsWith('models.') ? 'Django models' : m[2].startsWith('SQLModel') ? 'SQLModel' : 'SQLAlchemy'
    }
  }
  return names.length ? { source, names: [...new Set(names)] } : null
}

function pythonMigrations(files: string[]): ProjectFacts['migrations'] {
  const alembic = files.filter((f) => /(^|\/)(alembic|migrations)\/versions\/[^/]+\.py$/.test(f))
  const django = files.filter((f) => /(^|\/)migrations\/\d{4}_[^/]+\.py$/.test(f))
  const within = alembic.length ? alembic : django
  if (within.length === 0) return null
  const dir = within[0].slice(0, within[0].lastIndexOf('/') + 1)
  const names = within.map((f) => f.slice(f.lastIndexOf('/') + 1).replace(/\.py$/, '')).sort()
  return { dir, count: within.length, latest: names.slice(-3) }
}

async function readPython(read: Read, files: string[], present: Set<string>): Promise<LanguageFacts> {
  const pyproject = present.has('pyproject.toml') ? await read('pyproject.toml') : ''
  const reqFiles = files.filter((f) => /^requirements[^/]*\.(txt|in)$/.test(f) || /^requirements\/[^/]+\.(txt|in)$/.test(f))
  const requirements = (await Promise.all(reqFiles.map((f) => read(f)))).join('\n') + (present.has('Pipfile') ? `\n${await read('Pipfile')}` : '')
  const deps = pythonDeps(pyproject, requirements)

  const pythonVersion =
    (await read('.python-version')).trim().split('\n')[0] ||
    version(/requires-python\s*=\s*["']([^"']+)["']/.exec(pyproject)?.[1]) ||
    version(/^python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1])
  const stack: ProjectFacts['stack'] = [{ layer: 'Language', name: 'Python', version: version(pythonVersion) }]
  const versions = new Map<string, string>()
  for (const [pkg, row] of Object.entries(PYTHON_PACKAGES)) {
    if (!deps.has(pkg)) continue
    const v = version(deps.get(pkg))
    // The frameworks `detect` records are listed from there; only their version comes from here.
    if (row.label) {
      if (v) versions.set(row.label, v)
      continue
    }
    stack.push({ layer: row.layer, name: row.name, version: v })
  }

  const testFiles = files.filter((f) => /(^|\/)test_[^/]*\.py$|_test\.py$/.test(f))
  const usesPytest = deps.has('pytest') || present.has('pytest.ini') || present.has('conftest.py') || /^\[tool\.pytest/m.test(pyproject)
  return {
    language: 'python',
    tool: pythonTool(present, pyproject),
    stack,
    versions,
    api: await pythonRoutes(read, files),
    testFrameworks: usesPytest ? ['pytest'] : testFiles.length ? ['unittest'] : [],
    testFiles,
    migrations: pythonMigrations(files),
    models: await pythonModels(read, files),
  }
}

// ── Go ──────────────────────────────────────────────────────────────────────

const GO_MODULES: Record<string, { layer: string; name: string; label?: string }> = {
  'github.com/gin-gonic/gin': { layer: 'Framework', name: 'Gin', label: 'gin' },
  'github.com/labstack/echo': { layer: 'Framework', name: 'Echo', label: 'echo' },
  'github.com/go-chi/chi': { layer: 'Framework', name: 'chi', label: 'chi' },
  'github.com/gofiber/fiber': { layer: 'Framework', name: 'Fiber', label: 'fiber' },
  'gorm.io/gorm': { layer: 'Database', name: 'GORM' },
  'github.com/jmoiron/sqlx': { layer: 'Database', name: 'sqlx' },
  'github.com/jackc/pgx': { layer: 'Database', name: 'pgx' },
  'github.com/golang-migrate/migrate': { layer: 'Database', name: 'golang-migrate' },
  'github.com/stretchr/testify': { layer: 'Testing', name: 'testify' },
}

async function readGo(read: Read, files: string[]): Promise<LanguageFacts> {
  const mod = await read('go.mod')
  const stack: ProjectFacts['stack'] = [{ layer: 'Language', name: 'Go', version: /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(mod)?.[1] }]
  const versions = new Map<string, string>()
  for (const [path, row] of Object.entries(GO_MODULES)) {
    const m = new RegExp(`^\\s*(?:require\\s+)?${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/v\\d+)?\\s+v(\\d+\\.\\d+(?:\\.\\d+)?)`, 'm').exec(mod)
    if (!m) continue
    if (row.label) versions.set(row.label, m[1])
    else stack.push({ layer: row.layer, name: row.name, version: m[1] })
  }
  const api: ProjectFacts['api'] = []
  for (const f of files.filter((p) => p.endsWith('.go') && !p.endsWith('_test.go')).slice(0, 1500)) {
    const text = await read(f)
    for (const m of text.matchAll(/\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g)) {
      api.push({ route: m[2], methods: [m[1].toUpperCase()], file: f })
    }
    // net/http, with Go 1.22's method patterns: `HandleFunc("GET /users/{id}", …)`.
    for (const m of text.matchAll(/\bHandle(?:Func)?\(\s*"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/[^"]*)"/g)) {
      api.push({ route: m[2], methods: [m[1] ?? 'ANY'], file: f })
    }
    if (api.length >= 80) break
  }
  const migrationFiles = files.filter((f) => /(^|\/)migrations\/[^/]+\.(up\.)?sql$/.test(f))
  return {
    language: 'go',
    tool: 'go',
    stack,
    versions,
    api,
    testFrameworks: files.some((f) => f.endsWith('_test.go')) ? ['go test'] : [],
    testFiles: files.filter((f) => f.endsWith('_test.go')),
    migrations: migrationFiles.length
      ? { dir: migrationFiles[0].slice(0, migrationFiles[0].lastIndexOf('/') + 1), count: migrationFiles.length, latest: migrationFiles.map((f) => f.slice(f.lastIndexOf('/') + 1)).sort().slice(-3) }
      : null,
    models: null,
  }
}

/** A Python or Go project's facts, when its root says it is one; null otherwise. */
export async function readLanguageFacts(read: Read, files: string[]): Promise<LanguageFacts | null> {
  const present = new Set(files.filter((f) => !f.includes('/')))
  if (present.has('go.mod')) return readGo(read, files)
  if (['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'setup.cfg'].some((f) => present.has(f))) {
    return readPython(read, files, present)
  }
  return null
}

// ── Commands declared outside package.json ───────────────────────────────────

/**
 * The commands a project declares for people to run: Makefile and justfile
 * targets, executables in `scripts/`, and — for Python and Go — the tools it
 * is set up for. `does` is the target's first recipe line, or what the tool is
 * for.
 */
export async function readCommands(read: Read, files: string[], lang: LanguageFacts | null): Promise<ProjectFacts['commands']> {
  const out: ProjectFacts['commands'] = []
  const seen = new Set<string>()
  const add = (cmd: string, does: string): void => {
    if (seen.has(cmd) || out.length >= 16) return
    seen.add(cmd)
    out.push({ cmd, does: does.replace(/\s+/g, ' ').trim() })
  }
  const makefile = files.find((f) => f === 'Makefile' || f === 'makefile' || f === 'GNUmakefile')
  if (makefile) {
    const text = await read(makefile)
    for (const m of text.matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)[^\n]*\n((?:\t[^\n]*\n?)*)/gm)) {
      add(`make ${m[1]}`, m[2].split('\n')[0]?.replace(/^\t@?/, '') ?? '')
    }
  }
  const justfile = files.find((f) => /^\.?justfile$/i.test(f))
  if (justfile) {
    const text = await read(justfile)
    for (const m of text.matchAll(/^@?([A-Za-z][\w-]*)(?:\s+[^:=\n]*)?:(?!=)[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/gm)) {
      add(`just ${m[1]}`, m[2].split('\n')[0]?.trim().replace(/^@/, '') ?? '')
    }
  }
  for (const f of files.filter((p) => /^scripts\/[A-Za-z][\w-]*(\.sh)?$/.test(p)).slice(0, 10)) {
    const first = (await read(f)).split('\n').find((l) => l.trim() && !l.startsWith('#!') && !/^set\s/.test(l.trim()) && !/^#\s*https?:\/\//.test(l.trim())) ?? ''
    add(`./${f}`, first.replace(/^#\s*/, ''))
  }
  if (lang?.language === 'python') {
    const run = { poetry: 'poetry run ', uv: 'uv run ', pdm: 'pdm run ', pipenv: 'pipenv run ' }[lang.tool] ?? ''
    add({ poetry: 'poetry install', uv: 'uv sync', pdm: 'pdm install', pipenv: 'pipenv install --dev' }[lang.tool] ?? 'pip install -r requirements.txt', 'install the dependencies')
    if (lang.testFrameworks.includes('pytest')) add(`${run}pytest`, 'run the tests')
    if (lang.stack.some((s) => s.name === 'Ruff') || files.includes('ruff.toml') || files.includes('.ruff.toml')) {
      add(`${run}ruff check .`, 'lint')
      add(`${run}ruff format .`, 'format')
    }
    if (lang.stack.some((s) => s.name === 'mypy')) add(`${run}mypy .`, 'type-check')
  }
  if (lang?.language === 'go') {
    add('go build ./...', 'build every package')
    add('go test ./...', 'run the tests')
    add('go vet ./...', 'report suspicious code')
    if (files.some((f) => /^\.golangci\.ya?ml$/.test(f))) add('golangci-lint run', 'lint')
  }
  return out
}
