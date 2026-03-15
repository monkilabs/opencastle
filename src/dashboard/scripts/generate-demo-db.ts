import { resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createConvoyStore } from '../../cli/convoy/store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iso(base: string, offsetMs = 0): string {
  return new Date(new Date(base).getTime() + offsetMs).toISOString()
}
function min(m: number): number { return m * 60_000 }
function sec(s: number): number { return s * 1_000 }
function getMechanism(phase: number, agent: string): string {
  if (agent === 'Architect' || agent === 'Reviewer' || agent === 'Security Expert') return 'sub-agent'
  if (phase === 1) return 'sub-agent'
  if (phase >= 3) return 'sub-agent'
  return 'background'
}

// ---------------------------------------------------------------------------
// Demo timestamps – spread over 40 days (2026-02-01 → 2026-03-12)
// ---------------------------------------------------------------------------

const DAYS: string[] = []
for (let d = 0; d < 40; d++) {
  const dt = new Date('2026-02-01T00:00:00.000Z')
  dt.setUTCDate(dt.getUTCDate() + d)
  DAYS.push(dt.toISOString().slice(0, 10))
}

function dayTs(dayIdx: number, hour = 10, minute = 0): string {
  return `${DAYS[dayIdx]}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createDemoDb(outPath: string, eventsOutPath?: string): Promise<void> {
  const dbPath = resolve(process.cwd(), outPath)
  mkdirSync(dirname(dbPath), { recursive: true })
  const store = createConvoyStore(dbPath)

  store.insertPipeline({ id: 'demo-pipeline-1', name: 'Auth & Dashboard Sprint', status: 'done', branch: 'sprint/auth-ui', spec_yaml: 'name: auth-dashboard-sprint', convoy_specs: JSON.stringify(['auth-revamp.yml', 'dashboard-ui.yml']), created_at: dayTs(2, 9) })

  // ── Convoy 1: Auth Revamp – DONE ─────────────────────────────────────
  const C1 = dayTs(2, 9)
  store.insertConvoy({ id: 'demo-auth-revamp', name: 'Auth System Revamp', spec_hash: 'h1', status: 'done', branch: 'feat/auth-v2', created_at: C1, spec_yaml: 'name: auth-revamp', pipeline_id: 'demo-pipeline-1' })
  store.updateConvoyStatus('demo-auth-revamp', 'done', { started_at: C1, finished_at: iso(C1, min(47)), total_tokens: 42850, total_cost_usd: 4.28 })
  const authTasks = [
    { id: 'auth-t1', phase: 1, prompt: 'Design OAuth2 token refresh architecture', agent: 'Architect', status: 'done' as const, retries: 0, tokens: 8400, cost: 0.84, start: iso(C1, sec(5)), end: iso(C1, min(9)) },
    { id: 'auth-t2', phase: 2, prompt: 'Implement JWT middleware with refresh rotation', agent: 'Developer', status: 'done' as const, retries: 1, tokens: 12600, cost: 1.26, start: iso(C1, min(10)), end: iso(C1, min(24)) },
    { id: 'auth-t3', phase: 2, prompt: 'Add RLS policies for session tokens', agent: 'Security Expert', status: 'done' as const, retries: 0, tokens: 9200, cost: 0.92, start: iso(C1, min(10)), end: iso(C1, min(20)) },
    { id: 'auth-t4', phase: 3, prompt: 'Write auth integration tests', agent: 'Testing Expert', status: 'done' as const, retries: 0, tokens: 8900, cost: 0.89, start: iso(C1, min(25)), end: iso(C1, min(37)) },
    { id: 'auth-t5', phase: 4, prompt: 'QA gate – security review', agent: 'Reviewer', status: 'done' as const, retries: 0, tokens: 3750, cost: 0.37, start: iso(C1, min(38)), end: iso(C1, min(46)) },
  ]
  for (const t of authTasks) {
    store.insertTask({ id: t.id, convoy_id: 'demo-auth-revamp', phase: t.phase, prompt: t.prompt, agent: t.agent, adapter: 'vscode', model: t.agent === 'Architect' ? 'claude-opus-4-6' : 'claude-sonnet-4-6', timeout_ms: 120000, status: t.status, retries: t.retries, max_retries: 3, files: null, depends_on: null, gates: null, outputs: JSON.stringify({ result: 'done' }), inputs: null })
    store.updateTaskStatus(t.id, 'demo-auth-revamp', t.status, { started_at: t.start, finished_at: t.end, total_tokens: t.tokens, cost_usd: t.cost })
    store.insertEvent({ convoy_id: 'demo-auth-revamp', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
    store.insertEvent({ convoy_id: 'demo-auth-revamp', task_id: t.id, worker_id: null, type: 'task_done', data: null, created_at: t.end })
  }

  // ── Convoy 2: Dashboard UI – DONE ────────────────────────────────────
  const C2 = dayTs(6, 14)
  store.insertConvoy({ id: 'demo-dashboard-ui', name: 'Observability Dashboard UI', spec_hash: 'h2', status: 'done', branch: 'feat/dashboard-v2', created_at: C2, spec_yaml: 'name: dashboard-ui', pipeline_id: 'demo-pipeline-1' })
  store.updateConvoyStatus('demo-dashboard-ui', 'done', { started_at: C2, finished_at: iso(C2, min(98)), total_tokens: 78400, total_cost_usd: 7.84 })
  const uiTasks = [
    { id: 'ui-t1', phase: 1, prompt: 'Design dark-theme component system', agent: 'UI/UX Expert', status: 'done' as const, retries: 0, tokens: 14200, cost: 1.42, start: iso(C2, sec(5)), end: iso(C2, min(19)) },
    { id: 'ui-t2', phase: 1, prompt: 'Implement KPI card components', agent: 'Developer', status: 'done' as const, retries: 0, tokens: 11800, cost: 1.18, start: iso(C2, sec(5)), end: iso(C2, min(16)) },
    { id: 'ui-t3', phase: 2, prompt: 'Build SVG donut charts and bar charts', agent: 'Developer', status: 'done' as const, retries: 1, tokens: 13500, cost: 1.35, start: iso(C2, min(20)), end: iso(C2, min(44)) },
    { id: 'ui-t4', phase: 2, prompt: 'Write dashboard CSS animations', agent: 'UI/UX Expert', status: 'done' as const, retries: 0, tokens: 9400, cost: 0.94, start: iso(C2, min(20)), end: iso(C2, min(38)) },
    { id: 'ui-t5', phase: 3, prompt: 'Accessibility audit and ARIA labels', agent: 'UI/UX Expert', status: 'done' as const, retries: 0, tokens: 8700, cost: 0.87, start: iso(C2, min(45)), end: iso(C2, min(58)) },
    { id: 'ui-t6', phase: 3, prompt: 'Cross-browser visual regression tests', agent: 'Testing Expert', status: 'done' as const, retries: 0, tokens: 11200, cost: 1.12, start: iso(C2, min(45)), end: iso(C2, min(62)) },
    { id: 'ui-t7', phase: 4, prompt: 'QA panel – design review', agent: 'Reviewer', status: 'done' as const, retries: 0, tokens: 9600, cost: 0.96, start: iso(C2, min(63)), end: iso(C2, min(97)) },
  ]
  for (const t of uiTasks) {
    store.insertTask({ id: t.id, convoy_id: 'demo-dashboard-ui', phase: t.phase, prompt: t.prompt, agent: t.agent, adapter: 'vscode', model: t.agent === 'UI/UX Expert' ? 'claude-opus-4-6' : 'claude-sonnet-4-6', timeout_ms: 120000, status: t.status, retries: t.retries, max_retries: 3, files: null, depends_on: null, gates: null, outputs: JSON.stringify({ result: 'done' }), inputs: null })
    store.updateTaskStatus(t.id, 'demo-dashboard-ui', t.status, { started_at: t.start, finished_at: t.end, total_tokens: t.tokens, cost_usd: t.cost })
    store.insertEvent({ convoy_id: 'demo-dashboard-ui', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
    store.insertEvent({ convoy_id: 'demo-dashboard-ui', task_id: t.id, worker_id: null, type: 'task_done', data: null, created_at: t.end })
  }

  // ── Convoy 3: API v2 – GATE_FAILED ──────────────────────────────────
  const C3 = dayTs(11, 16)
  store.insertConvoy({ id: 'demo-api-v2', name: 'REST API v2 Migration', spec_hash: 'h3', status: 'gate_failed', branch: 'feat/api-v2', created_at: C3, spec_yaml: 'name: api-v2' })
  store.updateConvoyStatus('demo-api-v2', 'gate_failed', { started_at: C3, finished_at: iso(C3, min(28)), total_tokens: 24600, total_cost_usd: 2.46 })
  const apiTasks = [
    { id: 'api-t1', phase: 1, prompt: 'Design RESTful v2 route contracts', agent: 'API Designer', status: 'done' as const, eventType: 'task_done', retries: 0, tokens: 7200, cost: 0.72, start: iso(C3, sec(5)), end: iso(C3, min(11)) },
    { id: 'api-t2', phase: 2, prompt: 'Implement rate limiting middleware', agent: 'Developer', status: 'done' as const, eventType: 'task_done', retries: 2, tokens: 11400, cost: 1.14, start: iso(C3, min(12)), end: iso(C3, min(23)) },
    { id: 'api-t3', phase: 3, prompt: 'Security gate – injection vulnerability scan', agent: 'Security Expert', status: 'gate_failed' as const, eventType: 'task_gate_failed', retries: 0, tokens: 6000, cost: 0.60, start: iso(C3, min(24)), end: iso(C3, min(27)) },
  ]
  for (const t of apiTasks) {
    store.insertTask({ id: t.id, convoy_id: 'demo-api-v2', phase: t.phase, prompt: t.prompt, agent: t.agent, adapter: 'vscode', model: 'claude-sonnet-4-6', timeout_ms: 120000, status: t.status, retries: t.retries, max_retries: 3, files: null, depends_on: null, gates: null, outputs: t.status === 'gate_failed' ? JSON.stringify({ gate_failure: 'SQL injection risk detected in query builder' }) : JSON.stringify({ result: 'done' }), inputs: null })
    store.updateTaskStatus(t.id, 'demo-api-v2', t.status, { started_at: t.start, finished_at: t.end, total_tokens: t.tokens, cost_usd: t.cost })
    store.insertEvent({ convoy_id: 'demo-api-v2', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
    store.insertEvent({ convoy_id: 'demo-api-v2', task_id: t.id, worker_id: null, type: t.eventType, data: t.status === 'gate_failed' ? JSON.stringify({ reason: 'SQL injection risk' }) : null, created_at: t.end })
  }

  // ── Convoy 4: Performance Optimization – DONE ────────────────────────
  const C4 = dayTs(16, 10)
  store.insertConvoy({ id: 'demo-perf-opt', name: 'Frontend Performance Boost', spec_hash: 'h4', status: 'done', branch: 'perf/core-web-vitals', created_at: C4, spec_yaml: 'name: perf-opt' })
  store.updateConvoyStatus('demo-perf-opt', 'done', { started_at: C4, finished_at: iso(C4, min(62)), total_tokens: 37200, total_cost_usd: 3.72 })
  const perfTasks = [
    { id: 'perf-t1', phase: 1, prompt: 'Profile bundle and identify bottlenecks', agent: 'Performance Expert', status: 'done' as const, retries: 0, tokens: 8900, cost: 0.89, start: iso(C4, sec(5)), end: iso(C4, min(13)) },
    { id: 'perf-t2', phase: 2, prompt: 'Code-split heavy chart library', agent: 'Developer', status: 'done' as const, retries: 0, tokens: 11200, cost: 1.12, start: iso(C4, min(14)), end: iso(C4, min(30)) },
    { id: 'perf-t3', phase: 2, prompt: 'Implement image lazy-loading and AVIF conversion', agent: 'Developer', status: 'done' as const, retries: 0, tokens: 9600, cost: 0.96, start: iso(C4, min(14)), end: iso(C4, min(27)) },
    { id: 'perf-t4', phase: 3, prompt: 'Validate Core Web Vitals improvements', agent: 'Performance Expert', status: 'done' as const, retries: 0, tokens: 7500, cost: 0.75, start: iso(C4, min(31)), end: iso(C4, min(44)) },
  ]
  for (const t of perfTasks) {
    store.insertTask({ id: t.id, convoy_id: 'demo-perf-opt', phase: t.phase, prompt: t.prompt, agent: t.agent, adapter: 'vscode', model: 'claude-sonnet-4-6', timeout_ms: 120000, status: t.status, retries: t.retries, max_retries: 3, files: null, depends_on: null, gates: null, outputs: JSON.stringify({ result: 'done' }), inputs: null })
    store.updateTaskStatus(t.id, 'demo-perf-opt', t.status, { started_at: t.start, finished_at: t.end, total_tokens: t.tokens, cost_usd: t.cost })
    store.insertEvent({ convoy_id: 'demo-perf-opt', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
    store.insertEvent({ convoy_id: 'demo-perf-opt', task_id: t.id, worker_id: null, type: 'task_done', data: null, created_at: t.end })
  }

  // ── Convoy 5: Data Pipeline – DONE ────────────────────────────────────
  const C5 = dayTs(21, 13)
  store.insertConvoy({ id: 'demo-data-pipeline', name: 'Analytics ETL Pipeline', spec_hash: 'h5', status: 'done', branch: 'feat/etl-v2', created_at: C5, spec_yaml: 'name: data-pipeline' })
  store.updateConvoyStatus('demo-data-pipeline', 'done', { started_at: C5, finished_at: iso(C5, min(38)), total_tokens: 28900, total_cost_usd: 2.89 })
  const etlTasks = [
    { id: 'etl-t1', phase: 1, prompt: 'Design ndjson processing schema', agent: 'Data Expert', status: 'done' as const, retries: 0, tokens: 7800, cost: 0.78, start: iso(C5, sec(5)), end: iso(C5, min(11)) },
    { id: 'etl-t2', phase: 2, prompt: 'Implement incremental ETL with deduplication', agent: 'Data Expert', status: 'done' as const, retries: 1, tokens: 12400, cost: 1.24, start: iso(C5, min(12)), end: iso(C5, min(30)) },
    { id: 'etl-t3', phase: 3, prompt: 'Write ETL test suite', agent: 'Testing Expert', status: 'done' as const, retries: 0, tokens: 8700, cost: 0.87, start: iso(C5, min(31)), end: iso(C5, min(37)) },
  ]
  for (const t of etlTasks) {
    store.insertTask({ id: t.id, convoy_id: 'demo-data-pipeline', phase: t.phase, prompt: t.prompt, agent: t.agent, adapter: 'vscode', model: 'claude-sonnet-4-6', timeout_ms: 120000, status: t.status, retries: t.retries, max_retries: 3, files: null, depends_on: null, gates: null, outputs: JSON.stringify({ result: 'done' }), inputs: null })
    store.updateTaskStatus(t.id, 'demo-data-pipeline', t.status, { started_at: t.start, finished_at: t.end, total_tokens: t.tokens, cost_usd: t.cost })
    store.insertEvent({ convoy_id: 'demo-data-pipeline', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
    store.insertEvent({ convoy_id: 'demo-data-pipeline', task_id: t.id, worker_id: null, type: 'task_done', data: null, created_at: t.end })
  }

  // ── Convoy 6: CI/CD Deployment – RUNNING ────────────────────────────
  const C6 = dayTs(38, 8)
  store.insertConvoy({ id: 'demo-deploy-ci', name: 'CI/CD Pipeline Setup', spec_hash: 'h6', status: 'running', branch: 'feat/ci-cd', created_at: C6, spec_yaml: 'name: deploy-ci' })
  store.updateConvoyStatus('demo-deploy-ci', 'running', { started_at: C6 })
  const ciTasks = [
    { id: 'ci-t1', phase: 1, prompt: 'Design GitHub Actions workflow matrix', agent: 'DevOps Expert', status: 'done' as const, running: false, retries: 0, tokens: 6400, cost: 0.64, start: iso(C6, sec(5)), end: iso(C6, min(14)) },
    { id: 'ci-t2', phase: 2, prompt: 'Configure nx affected build caching', agent: 'DevOps Expert', status: 'running' as const, running: true, retries: 0, tokens: 0, cost: 0, start: iso(C6, min(15)), end: '' },
    { id: 'ci-t3', phase: 2, prompt: 'Set up staging environment deployment', agent: 'DevOps Expert', status: 'pending' as const, running: false, retries: 0, tokens: 0, cost: 0, start: '', end: '' },
  ]
  for (const t of ciTasks) {
    store.insertTask({ id: t.id, convoy_id: 'demo-deploy-ci', phase: t.phase, prompt: t.prompt, agent: t.agent, adapter: 'vscode', model: 'claude-sonnet-4-6', timeout_ms: 120000, status: t.status, retries: t.retries, max_retries: 3, files: null, depends_on: null, gates: null, outputs: t.status === 'done' ? JSON.stringify({ result: 'done' }) : null, inputs: null })
    if (t.status === 'done') {
      store.updateTaskStatus(t.id, 'demo-deploy-ci', t.status, { started_at: t.start, finished_at: t.end, total_tokens: t.tokens, cost_usd: t.cost })
      store.insertEvent({ convoy_id: 'demo-deploy-ci', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
      store.insertEvent({ convoy_id: 'demo-deploy-ci', task_id: t.id, worker_id: null, type: 'task_done', data: null, created_at: t.end })
    } else if (t.running) {
      store.updateTaskStatus(t.id, 'demo-deploy-ci', t.status, { started_at: t.start })
      store.insertEvent({ convoy_id: 'demo-deploy-ci', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
    }
  }

  // ── Convoy 7: Docs Update – DONE ────────────────────────────────────
  const C7 = dayTs(27, 15)
  store.insertConvoy({ id: 'demo-docs-update', name: 'Documentation Refresh', spec_hash: 'h7', status: 'done', branch: 'docs/update-march', created_at: C7, spec_yaml: 'name: docs-update' })
  store.updateConvoyStatus('demo-docs-update', 'done', { started_at: C7, finished_at: iso(C7, min(22)), total_tokens: 14800, total_cost_usd: 1.48 })
  const docTasks = [
    { id: 'docs-t1', phase: 1, prompt: 'Update README and ARCHITECTURE docs', agent: 'Documentation Writer', status: 'done' as const, retries: 0, tokens: 8200, cost: 0.82, start: iso(C7, sec(5)), end: iso(C7, min(14)) },
    { id: 'docs-t2', phase: 2, prompt: 'Generate API reference from source', agent: 'Documentation Writer', status: 'done' as const, retries: 0, tokens: 6600, cost: 0.66, start: iso(C7, min(15)), end: iso(C7, min(21)) },
  ]
  for (const t of docTasks) {
    store.insertTask({ id: t.id, convoy_id: 'demo-docs-update', phase: t.phase, prompt: t.prompt, agent: t.agent, adapter: 'vscode', model: 'claude-haiku-3-5', timeout_ms: 120000, status: t.status, retries: t.retries, max_retries: 3, files: null, depends_on: null, gates: null, outputs: JSON.stringify({ result: 'done' }), inputs: null })
    store.updateTaskStatus(t.id, 'demo-docs-update', t.status, { started_at: t.start, finished_at: t.end, total_tokens: t.tokens, cost_usd: t.cost })
    store.insertEvent({ convoy_id: 'demo-docs-update', task_id: t.id, worker_id: null, type: 'task_started', data: JSON.stringify({ mechanism: getMechanism(t.phase, t.agent) }), created_at: t.start })
    store.insertEvent({ convoy_id: 'demo-docs-update', task_id: t.id, worker_id: null, type: 'task_done', data: null, created_at: t.end })
  }

  // ── Review data ──────────────────────────────────────────────────────
  // Auth Revamp: fast-review pass on QA gate task
  store.updateTaskReview('auth-t5', 'demo-auth-revamp', {
    review_level: 'fast', review_verdict: 'pass',
    review_tokens: 1850, review_model: 'claude-haiku-3-5', panel_attempts: 0,
  })
  // Dashboard UI: panel review (2 attempts — first blocked, then passed)
  store.updateTaskReview('ui-t7', 'demo-dashboard-ui', {
    review_level: 'panel', review_verdict: 'pass',
    review_tokens: 4800, review_model: 'claude-opus-4-6', panel_attempts: 2,
  })
  // API v2: deep security gate review blocked (gate failure)
  store.updateTaskReview('api-t3', 'demo-api-v2', {
    review_level: 'deep', review_verdict: 'block',
    review_tokens: 2100, review_model: 'claude-sonnet-4-6', panel_attempts: 1,
  })
  // Perf Opt: add reviewer task + fast review pass
  store.insertTask({ id: 'perf-t5', convoy_id: 'demo-perf-opt', phase: 4, prompt: 'Fast review – performance changes', agent: 'Reviewer', adapter: 'vscode', model: 'claude-haiku-3-5', timeout_ms: 60000, status: 'done', retries: 0, max_retries: 3, files: null, depends_on: null, gates: null })
  store.updateTaskStatus('perf-t5', 'demo-perf-opt', 'done', { started_at: iso(C4, min(45)), finished_at: iso(C4, min(52)), total_tokens: 1200, cost_usd: 0.12 })
  store.updateTaskReview('perf-t5', 'demo-perf-opt', {
    review_level: 'fast', review_verdict: 'pass',
    review_tokens: 1200, review_model: 'claude-haiku-3-5', panel_attempts: 0,
  })
  // Data Pipeline: add reviewer task + fast review pass
  store.insertTask({ id: 'etl-t4', convoy_id: 'demo-data-pipeline', phase: 4, prompt: 'Fast review – ETL pipeline', agent: 'Reviewer', adapter: 'vscode', model: 'claude-haiku-3-5', timeout_ms: 60000, status: 'done', retries: 0, max_retries: 3, files: null, depends_on: null, gates: null })
  store.updateTaskStatus('etl-t4', 'demo-data-pipeline', 'done', { started_at: iso(C5, min(32)), finished_at: iso(C5, min(37)), total_tokens: 900, cost_usd: 0.09 })
  store.updateTaskReview('etl-t4', 'demo-data-pipeline', {
    review_level: 'fast', review_verdict: 'pass',
    review_tokens: 900, review_model: 'claude-haiku-3-5', panel_attempts: 0,
  })
  // Docs Update: add reviewer task + fast review pass
  store.insertTask({ id: 'docs-t3', convoy_id: 'demo-docs-update', phase: 3, prompt: 'Fast review – documentation changes', agent: 'Reviewer', adapter: 'vscode', model: 'claude-haiku-3-5', timeout_ms: 60000, status: 'done', retries: 0, max_retries: 3, files: null, depends_on: null, gates: null })
  store.updateTaskStatus('docs-t3', 'demo-docs-update', 'done', { started_at: iso(C7, min(17)), finished_at: iso(C7, min(21)), total_tokens: 800, cost_usd: 0.08 })
  store.updateTaskReview('docs-t3', 'demo-docs-update', {
    review_level: 'fast', review_verdict: 'pass',
    review_tokens: 800, review_model: 'claude-haiku-3-5', panel_attempts: 0,
  })

  // ── Drift data ────────────────────────────────────────────────────────
  store.updateTaskDrift('auth-t2', 'demo-auth-revamp', { drift_score: 0.15, drift_retried: 1 })
  store.updateTaskDrift('ui-t3', 'demo-dashboard-ui', { drift_score: 0.28, drift_retried: 1 })
  store.updateTaskDrift('etl-t2', 'demo-data-pipeline', { drift_score: 0.12, drift_retried: 0 })

  // ── Secret leak event (drives drift section banner in deploy-ci) ──────
  store.insertEvent({
    convoy_id: 'demo-deploy-ci', task_id: 'ci-t1', worker_id: null,
    type: 'secret_leak_prevented',
    data: JSON.stringify({ secret_type: 'API_KEY', file: '.env.staging', masked: true }),
    created_at: iso(C6, min(8)),
  })

  // ── DLQ entries ───────────────────────────────────────────────────────
  store.insertDlqEntry({
    id: 'dlq-api-1', convoy_id: 'demo-api-v2', task_id: 'api-t3',
    agent: 'Security Expert', failure_type: 'gate_failed',
    error_output: 'SQL injection risk detected in query builder at src/db/query.ts:45. Parameterized queries required.',
    attempts: 1, tokens_spent: 6000, escalation_task_id: null,
    resolved: 0, resolution: null,
    created_at: iso(C3, min(27)), resolved_at: null,
  })
  store.insertDlqEntry({
    id: 'dlq-ci-1', convoy_id: 'demo-deploy-ci', task_id: 'ci-t2',
    agent: 'DevOps Expert', failure_type: 'timeout',
    error_output: 'Task exceeded max execution time (120s) during nx cache configuration. Cache key computation timed out.',
    attempts: 2, tokens_spent: 3200, escalation_task_id: null,
    resolved: 0, resolution: null,
    created_at: iso(C6, min(35)), resolved_at: null,
  })
  store.insertDlqEntry({
    id: 'dlq-ui-1', convoy_id: 'demo-dashboard-ui', task_id: 'ui-t7',
    agent: 'Reviewer', failure_type: 'review_blocked',
    error_output: 'Panel review blocked: accessibility issues in chart components – 2 major findings (missing ARIA labels, insufficient contrast ratio).',
    attempts: 1, tokens_spent: 2400, escalation_task_id: null,
    resolved: 1, resolution: 'Re-reviewed after accessibility fixes applied in ui-t5',
    created_at: iso(C2, min(65)), resolved_at: iso(C2, min(97)),
  })

  // ── Artifacts ────────────────────────────────────────────────────────
  const demoArtifacts: Array<{ convoyId: string; taskId: string; name: string; type: 'file' | 'summary' | 'json' }> = [
    { convoyId: 'demo-auth-revamp', taskId: 'auth-t2', name: 'libs/auth/src/jwt-middleware.ts', type: 'file' },
    { convoyId: 'demo-auth-revamp', taskId: 'auth-t3', name: 'libs/auth/src/rls-policies.sql', type: 'file' },
    { convoyId: 'demo-auth-revamp', taskId: 'auth-t4', name: 'tests/auth/integration.test.ts', type: 'file' },
    { convoyId: 'demo-auth-revamp', taskId: 'auth-t5', name: 'reports/auth-review-summary.md', type: 'summary' },
    { convoyId: 'demo-dashboard-ui', taskId: 'ui-t1', name: 'src/components/design-tokens.ts', type: 'file' },
    { convoyId: 'demo-dashboard-ui', taskId: 'ui-t2', name: 'src/components/KpiCard.tsx', type: 'file' },
    { convoyId: 'demo-dashboard-ui', taskId: 'ui-t3', name: 'src/components/DonutChart.tsx', type: 'file' },
    { convoyId: 'demo-dashboard-ui', taskId: 'ui-t4', name: 'src/styles/animations.css', type: 'file' },
    { convoyId: 'demo-dashboard-ui', taskId: 'ui-t6', name: 'reports/visual-regression.json', type: 'json' },
    { convoyId: 'demo-dashboard-ui', taskId: 'ui-t7', name: 'reports/panel-review-dashboard.md', type: 'summary' },
    { convoyId: 'demo-api-v2', taskId: 'api-t1', name: 'docs/api-v2-contract.json', type: 'json' },
    { convoyId: 'demo-api-v2', taskId: 'api-t2', name: 'src/api/rate-limiter.ts', type: 'file' },
    { convoyId: 'demo-api-v2', taskId: 'api-t3', name: 'reports/security-gate-failure.md', type: 'summary' },
    { convoyId: 'demo-perf-opt', taskId: 'perf-t1', name: 'reports/bundle-analysis.json', type: 'json' },
    { convoyId: 'demo-perf-opt', taskId: 'perf-t2', name: 'src/charts/index.ts', type: 'file' },
    { convoyId: 'demo-perf-opt', taskId: 'perf-t3', name: 'src/utils/image-loader.ts', type: 'file' },
    { convoyId: 'demo-perf-opt', taskId: 'perf-t4', name: 'reports/web-vitals-improvement.md', type: 'summary' },
    { convoyId: 'demo-data-pipeline', taskId: 'etl-t1', name: 'src/etl/schema.ts', type: 'file' },
    { convoyId: 'demo-data-pipeline', taskId: 'etl-t2', name: 'src/etl/pipeline.ts', type: 'file' },
    { convoyId: 'demo-data-pipeline', taskId: 'etl-t3', name: 'tests/etl/pipeline.test.ts', type: 'file' },
    { convoyId: 'demo-docs-update', taskId: 'docs-t1', name: 'docs/README.md', type: 'file' },
    { convoyId: 'demo-docs-update', taskId: 'docs-t1', name: 'docs/ARCHITECTURE.md', type: 'file' },
    { convoyId: 'demo-docs-update', taskId: 'docs-t2', name: 'docs/api-reference.json', type: 'json' },
    { convoyId: 'demo-deploy-ci', taskId: 'ci-t1', name: '.github/workflows/ci.yml', type: 'file' },
  ]
  for (const a of demoArtifacts) {
    store.insertArtifact({
      id: `artifact-${a.convoyId}-${a.name.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
      convoy_id: a.convoyId, task_id: a.taskId,
      name: a.name, type: a.type,
      content: `Demo artifact: ${a.name}`,
      created_at: new Date().toISOString(),
    })
  }

  store.close()
  console.log(`Created demo convoy DB at ${dbPath}`)

  // ── Generate demo observability events.ndjson ──────────────────────────
  if (!eventsOutPath) return
  const eventsPath = resolve(process.cwd(), eventsOutPath)
  mkdirSync(dirname(eventsPath), { recursive: true })
  const lines: string[] = []

  function emit(record: Record<string, unknown>) {
    lines.push(JSON.stringify(record))
  }

  // ── Session records (62 entries, spanning 40 days) ───────────────────
  type Outcome = 'success' | 'partial' | 'failed'
  const sessions: Array<{
    dayIdx: number; hour: number; agent: string; model: string
    task: string; outcome: Outcome; duration_min: number
    files_changed: number; retries: number; convoy_id?: string; tracker_issue?: string
    lessons_added?: string[]; discoveries?: string[]
  }> = [
    // Day 0-2: Auth planning
    { dayIdx: 0, hour: 9, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Plan auth system revamp', outcome: 'success', duration_min: 8, files_changed: 2, retries: 0, convoy_id: 'demo-auth-revamp', tracker_issue: 'TASK-01' },
    { dayIdx: 1, hour: 10, agent: 'Architect', model: 'claude-opus-4-6', task: 'Design OAuth2 token refresh architecture', outcome: 'success', duration_min: 9, files_changed: 3, retries: 0, convoy_id: 'demo-auth-revamp', tracker_issue: 'TASK-02' },
    { dayIdx: 2, hour: 9, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Orchestrate auth revamp convoy', outcome: 'success', duration_min: 47, files_changed: 0, retries: 0, convoy_id: 'demo-auth-revamp', tracker_issue: 'TASK-03' },
    { dayIdx: 2, hour: 9, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Implement JWT middleware with refresh rotation', outcome: 'success', duration_min: 14, files_changed: 6, retries: 1, convoy_id: 'demo-auth-revamp', tracker_issue: 'TASK-04', lessons_added: ['Always invalidate old tokens before issuing new ones'] },
    { dayIdx: 2, hour: 9, agent: 'Security Expert', model: 'claude-sonnet-4-6', task: 'Add RLS policies for session tokens', outcome: 'success', duration_min: 10, files_changed: 4, retries: 0, convoy_id: 'demo-auth-revamp', tracker_issue: 'TASK-05' },
    { dayIdx: 2, hour: 10, agent: 'Testing Expert', model: 'claude-sonnet-4-6', task: 'Write auth integration tests', outcome: 'success', duration_min: 12, files_changed: 5, retries: 0, convoy_id: 'demo-auth-revamp', tracker_issue: 'TASK-06' },
    { dayIdx: 2, hour: 11, agent: 'Reviewer', model: 'claude-sonnet-4-6', task: 'QA review – auth middleware', outcome: 'success', duration_min: 8, files_changed: 0, retries: 0, convoy_id: 'demo-auth-revamp', tracker_issue: 'TASK-07' },
    // Day 3-5
    { dayIdx: 3, hour: 14, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Fix token expiry edge case', outcome: 'success', duration_min: 6, files_changed: 2, retries: 0, tracker_issue: 'TASK-08' },
    { dayIdx: 4, hour: 11, agent: 'Security Expert', model: 'claude-sonnet-4-6', task: 'Audit CSRF protection mechanisms', outcome: 'partial', duration_min: 15, files_changed: 3, retries: 1, tracker_issue: 'TASK-09', discoveries: ['Rate limiting missing on /api/tokens'] },
    { dayIdx: 5, hour: 10, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Plan dashboard UI redesign', outcome: 'success', duration_min: 6, files_changed: 1, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-10' },
    // Day 6-8: Dashboard UI
    { dayIdx: 6, hour: 14, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Orchestrate dashboard UI convoy', outcome: 'success', duration_min: 98, files_changed: 0, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-11' },
    { dayIdx: 6, hour: 14, agent: 'UI/UX Expert', model: 'claude-opus-4-6', task: 'Design dark-theme component system', outcome: 'success', duration_min: 19, files_changed: 8, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-12' },
    { dayIdx: 6, hour: 14, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Implement KPI card components', outcome: 'success', duration_min: 16, files_changed: 7, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-13' },
    { dayIdx: 6, hour: 15, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Build SVG donut charts and bar charts', outcome: 'success', duration_min: 24, files_changed: 5, retries: 1, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-14', lessons_added: ['SVG stroke-dashoffset must be negated for CCW donut segments'] },
    { dayIdx: 6, hour: 15, agent: 'UI/UX Expert', model: 'claude-opus-4-6', task: 'Write dashboard CSS animations', outcome: 'success', duration_min: 18, files_changed: 3, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-15' },
    { dayIdx: 7, hour: 9, agent: 'UI/UX Expert', model: 'claude-opus-4-6', task: 'Accessibility audit and ARIA labels', outcome: 'success', duration_min: 13, files_changed: 6, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-16' },
    { dayIdx: 7, hour: 9, agent: 'Testing Expert', model: 'claude-sonnet-4-6', task: 'Cross-browser visual regression tests', outcome: 'success', duration_min: 17, files_changed: 4, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-17' },
    { dayIdx: 7, hour: 11, agent: 'Reviewer', model: 'claude-sonnet-4-6', task: 'Panel review – dashboard UI', outcome: 'success', duration_min: 34, files_changed: 0, retries: 0, convoy_id: 'demo-dashboard-ui', tracker_issue: 'TASK-18' },
    { dayIdx: 8, hour: 10, agent: 'Copywriter', model: 'claude-sonnet-4-6', task: 'Write dashboard empty state copy', outcome: 'success', duration_min: 5, files_changed: 1, retries: 0, tracker_issue: 'TASK-19' },
    // Day 9-13: API work
    { dayIdx: 9, hour: 10, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Plan REST API v2 migration', outcome: 'success', duration_min: 7, files_changed: 1, retries: 0, convoy_id: 'demo-api-v2', tracker_issue: 'TASK-20' },
    { dayIdx: 10, hour: 11, agent: 'API Designer', model: 'claude-sonnet-4-6', task: 'Design RESTful v2 route contracts', outcome: 'success', duration_min: 11, files_changed: 4, retries: 0, convoy_id: 'demo-api-v2', tracker_issue: 'TASK-21' },
    { dayIdx: 11, hour: 16, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Orchestrate API v2 convoy', outcome: 'failed', duration_min: 28, files_changed: 0, retries: 0, convoy_id: 'demo-api-v2', tracker_issue: 'TASK-22' },
    { dayIdx: 11, hour: 16, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Implement rate limiting middleware', outcome: 'partial', duration_min: 11, files_changed: 5, retries: 2, convoy_id: 'demo-api-v2', tracker_issue: 'TASK-23' },
    { dayIdx: 11, hour: 17, agent: 'Security Expert', model: 'claude-sonnet-4-6', task: 'Security gate – injection vulnerability scan', outcome: 'failed', duration_min: 3, files_changed: 0, retries: 0, convoy_id: 'demo-api-v2', tracker_issue: 'TASK-24', discoveries: ['SQL injection risk in query builder', 'Missing input sanitization on user endpoint'] },
    { dayIdx: 12, hour: 9, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Patch SQL injection in query builder', outcome: 'success', duration_min: 8, files_changed: 3, retries: 0, tracker_issue: 'TASK-25' },
    { dayIdx: 13, hour: 14, agent: 'Security Expert', model: 'claude-sonnet-4-6', task: 'Re-audit query builder after patch', outcome: 'success', duration_min: 7, files_changed: 1, retries: 0, tracker_issue: 'TASK-26' },
    // Day 14-18: Performance
    { dayIdx: 14, hour: 10, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Plan performance optimization sprint', outcome: 'success', duration_min: 5, files_changed: 1, retries: 0, convoy_id: 'demo-perf-opt', tracker_issue: 'TASK-27' },
    { dayIdx: 15, hour: 11, agent: 'Performance Expert', model: 'claude-sonnet-4-6', task: 'Profile bundle and identify bottlenecks', outcome: 'success', duration_min: 13, files_changed: 2, retries: 0, convoy_id: 'demo-perf-opt', tracker_issue: 'TASK-28' },
    { dayIdx: 16, hour: 10, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Orchestrate performance optimization convoy', outcome: 'success', duration_min: 62, files_changed: 0, retries: 0, convoy_id: 'demo-perf-opt', tracker_issue: 'TASK-29' },
    { dayIdx: 16, hour: 10, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Code-split heavy chart library', outcome: 'success', duration_min: 16, files_changed: 8, retries: 0, convoy_id: 'demo-perf-opt', tracker_issue: 'TASK-30' },
    { dayIdx: 16, hour: 10, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Implement image lazy-loading and AVIF conversion', outcome: 'success', duration_min: 13, files_changed: 5, retries: 0, convoy_id: 'demo-perf-opt', tracker_issue: 'TASK-31' },
    { dayIdx: 16, hour: 11, agent: 'Performance Expert', model: 'claude-sonnet-4-6', task: 'Validate Core Web Vitals improvements', outcome: 'success', duration_min: 13, files_changed: 0, retries: 0, convoy_id: 'demo-perf-opt', tracker_issue: 'TASK-32' },
    { dayIdx: 17, hour: 14, agent: 'Reviewer', model: 'claude-haiku-3-5', task: 'Fast review – performance PR', outcome: 'success', duration_min: 6, files_changed: 0, retries: 0, tracker_issue: 'TASK-33' },
    { dayIdx: 18, hour: 9, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Fix LCP regression on mobile', outcome: 'success', duration_min: 9, files_changed: 3, retries: 1, tracker_issue: 'TASK-34', lessons_added: ['Always check mobile viewport when optimizing LCP'] },
    // Day 19-23: Data pipeline
    { dayIdx: 19, hour: 13, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Plan analytics ETL pipeline', outcome: 'success', duration_min: 6, files_changed: 1, retries: 0, convoy_id: 'demo-data-pipeline', tracker_issue: 'TASK-35' },
    { dayIdx: 20, hour: 11, agent: 'Data Expert', model: 'claude-sonnet-4-6', task: 'Design ndjson processing schema', outcome: 'success', duration_min: 11, files_changed: 3, retries: 0, convoy_id: 'demo-data-pipeline', tracker_issue: 'TASK-36' },
    { dayIdx: 21, hour: 13, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Orchestrate data pipeline convoy', outcome: 'success', duration_min: 38, files_changed: 0, retries: 0, convoy_id: 'demo-data-pipeline', tracker_issue: 'TASK-37' },
    { dayIdx: 21, hour: 13, agent: 'Data Expert', model: 'claude-sonnet-4-6', task: 'Implement incremental ETL with deduplication', outcome: 'success', duration_min: 18, files_changed: 7, retries: 1, convoy_id: 'demo-data-pipeline', tracker_issue: 'TASK-38' },
    { dayIdx: 21, hour: 14, agent: 'Testing Expert', model: 'claude-haiku-3-5', task: 'Write ETL test suite', outcome: 'success', duration_min: 6, files_changed: 4, retries: 0, convoy_id: 'demo-data-pipeline', tracker_issue: 'TASK-39' },
    { dayIdx: 22, hour: 15, agent: 'Reviewer', model: 'claude-haiku-3-5', task: 'Fast review – data pipeline', outcome: 'success', duration_min: 5, files_changed: 0, retries: 0, tracker_issue: 'TASK-40' },
    { dayIdx: 23, hour: 10, agent: 'Documentation Writer', model: 'claude-haiku-3-5', task: 'Document ETL schema and configuration', outcome: 'success', duration_min: 8, files_changed: 2, retries: 0, tracker_issue: 'TASK-41' },
    // Day 24-29: Docs
    { dayIdx: 25, hour: 10, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Plan documentation refresh', outcome: 'success', duration_min: 4, files_changed: 0, retries: 0, convoy_id: 'demo-docs-update', tracker_issue: 'TASK-42' },
    { dayIdx: 27, hour: 15, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Orchestrate documentation update convoy', outcome: 'success', duration_min: 22, files_changed: 0, retries: 0, convoy_id: 'demo-docs-update', tracker_issue: 'TASK-43' },
    { dayIdx: 27, hour: 15, agent: 'Documentation Writer', model: 'claude-haiku-3-5', task: 'Update README and ARCHITECTURE docs', outcome: 'success', duration_min: 14, files_changed: 5, retries: 0, convoy_id: 'demo-docs-update', tracker_issue: 'TASK-44' },
    { dayIdx: 27, hour: 16, agent: 'Documentation Writer', model: 'claude-haiku-3-5', task: 'Generate API reference from source', outcome: 'success', duration_min: 6, files_changed: 3, retries: 0, convoy_id: 'demo-docs-update', tracker_issue: 'TASK-45' },
    { dayIdx: 28, hour: 11, agent: 'Copywriter', model: 'claude-haiku-3-5', task: 'Update marketing copy for v2 features', outcome: 'success', duration_min: 7, files_changed: 2, retries: 0, tracker_issue: 'TASK-46' },
    { dayIdx: 29, hour: 14, agent: 'SEO Specialist', model: 'claude-haiku-3-5', task: 'Add structured data and meta tags', outcome: 'success', duration_min: 9, files_changed: 4, retries: 0, tracker_issue: 'TASK-47' },
    // Day 30-35: CI/CD
    { dayIdx: 30, hour: 9, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Plan CI/CD pipeline setup', outcome: 'success', duration_min: 5, files_changed: 1, retries: 0, convoy_id: 'demo-deploy-ci', tracker_issue: 'TASK-48' },
    { dayIdx: 31, hour: 10, agent: 'DevOps Expert', model: 'claude-sonnet-4-6', task: 'Design GitHub Actions workflow matrix', outcome: 'success', duration_min: 12, files_changed: 4, retries: 0, convoy_id: 'demo-deploy-ci', tracker_issue: 'TASK-49' },
    { dayIdx: 32, hour: 11, agent: 'DevOps Expert', model: 'claude-sonnet-4-6', task: 'Configure secret rotation policy', outcome: 'partial', duration_min: 14, files_changed: 3, retries: 1, tracker_issue: 'TASK-50' },
    { dayIdx: 33, hour: 15, agent: 'Security Expert', model: 'claude-sonnet-4-6', task: 'Review deployment security headers', outcome: 'success', duration_min: 11, files_changed: 2, retries: 0, tracker_issue: 'TASK-51' },
    { dayIdx: 34, hour: 11, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Add smoke test after deployment', outcome: 'success', duration_min: 8, files_changed: 3, retries: 0, tracker_issue: 'TASK-52' },
    { dayIdx: 35, hour: 10, agent: 'Reviewer', model: 'claude-haiku-3-5', task: 'Review CI config for security issues', outcome: 'success', duration_min: 7, files_changed: 0, retries: 0, tracker_issue: 'TASK-53' },
    // Day 36-39: misc
    { dayIdx: 36, hour: 9, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Resolve TypeScript strict mode errors', outcome: 'success', duration_min: 11, files_changed: 9, retries: 0, tracker_issue: 'TASK-54' },
    { dayIdx: 36, hour: 14, agent: 'Testing Expert', model: 'claude-sonnet-4-6', task: 'Increase test coverage to 95%', outcome: 'success', duration_min: 19, files_changed: 12, retries: 1, tracker_issue: 'TASK-55', lessons_added: ['Mock SQLite in unit tests to avoid file system issues'] },
    { dayIdx: 37, hour: 10, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Implement watch mode with cron triggers', outcome: 'success', duration_min: 28, files_changed: 6, retries: 0, tracker_issue: 'TASK-56' },
    { dayIdx: 37, hour: 15, agent: 'UI/UX Expert', model: 'claude-opus-4-6', task: 'Refine responsive breakpoints', outcome: 'success', duration_min: 14, files_changed: 4, retries: 0, tracker_issue: 'TASK-57' },
    { dayIdx: 38, hour: 8, agent: 'Team Lead (OpenCastle)', model: 'claude-opus-4-6', task: 'Orchestrate CI/CD deployment convoy', outcome: 'partial', duration_min: 20, files_changed: 0, retries: 0, convoy_id: 'demo-deploy-ci', tracker_issue: 'TASK-58' },
    { dayIdx: 38, hour: 8, agent: 'DevOps Expert', model: 'claude-sonnet-4-6', task: 'Configure nx affected build caching', outcome: 'partial', duration_min: 18, files_changed: 5, retries: 0, convoy_id: 'demo-deploy-ci', tracker_issue: 'TASK-59' },
    { dayIdx: 39, hour: 9, agent: 'Developer', model: 'claude-sonnet-4-6', task: 'Add agents CLI command for identity management', outcome: 'success', duration_min: 16, files_changed: 7, retries: 0, tracker_issue: 'TASK-60' },
    { dayIdx: 39, hour: 11, agent: 'Reviewer', model: 'claude-haiku-3-5', task: 'Fast review – agents CLI', outcome: 'success', duration_min: 5, files_changed: 0, retries: 0, tracker_issue: 'TASK-61' },
  ]

  for (const s of sessions) {
    emit({
      type: 'session',
      timestamp: dayTs(s.dayIdx, s.hour, (s.dayIdx * 7 + s.hour * 3) % 50),
      agent: s.agent, model: s.model, task: s.task, outcome: s.outcome,
      duration_min: s.duration_min, files_changed: s.files_changed, retries: s.retries,
      ...(s.convoy_id ? { convoy_id: s.convoy_id } : {}),
      ...(s.tracker_issue ? { tracker_issue: s.tracker_issue } : {}),
      ...(s.lessons_added ? { lessons_added: s.lessons_added } : {}),
      ...(s.discoveries ? { discoveries: s.discoveries } : {}),
    })
  }

  // ── Delegation records ────────────────────────────────────────────────
  const delegations: Array<{
    dayIdx: number; hour: number; agent: string; task: string
    outcome: string; tier: string; mechanism: string; phase: number
    convoy_id?: string; model: string
  }> = [
    { dayIdx: 1, hour: 10, agent: 'Architect', task: 'OAuth2 architecture review', outcome: 'success', tier: 'premium', mechanism: 'sub-agent', phase: 1, convoy_id: 'demo-auth-revamp', model: 'claude-opus-4-6' },
    { dayIdx: 2, hour: 9, agent: 'Developer', task: 'Implement JWT middleware', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-auth-revamp', model: 'claude-sonnet-4-6' },
    { dayIdx: 2, hour: 9, agent: 'Security Expert', task: 'RLS policies for session tokens', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-auth-revamp', model: 'claude-sonnet-4-6' },
    { dayIdx: 2, hour: 10, agent: 'Testing Expert', task: 'Auth integration tests', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 3, convoy_id: 'demo-auth-revamp', model: 'claude-sonnet-4-6' },
    { dayIdx: 2, hour: 11, agent: 'Reviewer', task: 'Auth QA gate', outcome: 'success', tier: 'economy', mechanism: 'sub-agent', phase: 4, convoy_id: 'demo-auth-revamp', model: 'claude-haiku-3-5' },
    { dayIdx: 4, hour: 11, agent: 'Security Expert', task: 'CSRF audit', outcome: 'partial', tier: 'standard', mechanism: 'sub-agent', phase: 2, model: 'claude-sonnet-4-6' },
    { dayIdx: 6, hour: 14, agent: 'UI/UX Expert', task: 'Component system design', outcome: 'success', tier: 'premium', mechanism: 'sub-agent', phase: 1, convoy_id: 'demo-dashboard-ui', model: 'claude-opus-4-6' },
    { dayIdx: 6, hour: 14, agent: 'Developer', task: 'KPI card implementation', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 1, convoy_id: 'demo-dashboard-ui', model: 'claude-sonnet-4-6' },
    { dayIdx: 6, hour: 15, agent: 'Developer', task: 'SVG chart components', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-dashboard-ui', model: 'claude-sonnet-4-6' },
    { dayIdx: 6, hour: 15, agent: 'UI/UX Expert', task: 'CSS animation system', outcome: 'success', tier: 'premium', mechanism: 'background', phase: 2, convoy_id: 'demo-dashboard-ui', model: 'claude-opus-4-6' },
    { dayIdx: 7, hour: 9, agent: 'UI/UX Expert', task: 'Accessibility audit', outcome: 'success', tier: 'premium', mechanism: 'sub-agent', phase: 3, convoy_id: 'demo-dashboard-ui', model: 'claude-opus-4-6' },
    { dayIdx: 7, hour: 9, agent: 'Testing Expert', task: 'Visual regression tests', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 3, convoy_id: 'demo-dashboard-ui', model: 'claude-sonnet-4-6' },
    { dayIdx: 7, hour: 11, agent: 'Reviewer', task: 'Panel review – dashboard', outcome: 'success', tier: 'economy', mechanism: 'sub-agent', phase: 4, convoy_id: 'demo-dashboard-ui', model: 'claude-haiku-3-5' },
    { dayIdx: 10, hour: 11, agent: 'API Designer', task: 'REST v2 route design', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 1, convoy_id: 'demo-api-v2', model: 'claude-sonnet-4-6' },
    { dayIdx: 11, hour: 16, agent: 'Developer', task: 'Rate limiting middleware', outcome: 'partial', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-api-v2', model: 'claude-sonnet-4-6' },
    { dayIdx: 11, hour: 17, agent: 'Security Expert', task: 'Injection vulnerability scan', outcome: 'failed', tier: 'standard', mechanism: 'sub-agent', phase: 3, convoy_id: 'demo-api-v2', model: 'claude-sonnet-4-6' },
    { dayIdx: 12, hour: 9, agent: 'Developer', task: 'Patch SQL injection', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 2, model: 'claude-sonnet-4-6' },
    { dayIdx: 15, hour: 11, agent: 'Performance Expert', task: 'Bundle profiling', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 1, convoy_id: 'demo-perf-opt', model: 'claude-sonnet-4-6' },
    { dayIdx: 16, hour: 10, agent: 'Developer', task: 'Code-split chart library', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-perf-opt', model: 'claude-sonnet-4-6' },
    { dayIdx: 16, hour: 10, agent: 'Developer', task: 'Image lazy-loading', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-perf-opt', model: 'claude-sonnet-4-6' },
    { dayIdx: 16, hour: 11, agent: 'Performance Expert', task: 'Core Web Vitals validation', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 3, convoy_id: 'demo-perf-opt', model: 'claude-sonnet-4-6' },
    { dayIdx: 17, hour: 14, agent: 'Reviewer', task: 'Performance PR review', outcome: 'success', tier: 'utility', mechanism: 'sub-agent', phase: 4, model: 'claude-haiku-3-5' },
    { dayIdx: 20, hour: 11, agent: 'Data Expert', task: 'ndjson schema design', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 1, convoy_id: 'demo-data-pipeline', model: 'claude-sonnet-4-6' },
    { dayIdx: 21, hour: 13, agent: 'Data Expert', task: 'ETL implementation', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-data-pipeline', model: 'claude-sonnet-4-6' },
    { dayIdx: 21, hour: 14, agent: 'Testing Expert', task: 'ETL test suite', outcome: 'success', tier: 'economy', mechanism: 'background', phase: 3, convoy_id: 'demo-data-pipeline', model: 'claude-haiku-3-5' },
    { dayIdx: 27, hour: 15, agent: 'Documentation Writer', task: 'README and ARCHITECTURE update', outcome: 'success', tier: 'economy', mechanism: 'sub-agent', phase: 1, convoy_id: 'demo-docs-update', model: 'claude-haiku-3-5' },
    { dayIdx: 27, hour: 16, agent: 'Documentation Writer', task: 'API reference generation', outcome: 'success', tier: 'economy', mechanism: 'sub-agent', phase: 2, convoy_id: 'demo-docs-update', model: 'claude-haiku-3-5' },
    { dayIdx: 31, hour: 10, agent: 'DevOps Expert', task: 'GitHub Actions workflow', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 1, convoy_id: 'demo-deploy-ci', model: 'claude-sonnet-4-6' },
    { dayIdx: 33, hour: 15, agent: 'Security Expert', task: 'Deployment security headers review', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 2, model: 'claude-sonnet-4-6' },
    { dayIdx: 35, hour: 10, agent: 'Reviewer', task: 'CI config security review', outcome: 'success', tier: 'utility', mechanism: 'sub-agent', phase: 3, model: 'claude-haiku-3-5' },
    { dayIdx: 36, hour: 9, agent: 'Developer', task: 'TypeScript strict mode fixes', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 2, model: 'claude-sonnet-4-6' },
    { dayIdx: 36, hour: 14, agent: 'Testing Expert', task: 'Increase test coverage', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 3, model: 'claude-sonnet-4-6' },
    { dayIdx: 37, hour: 10, agent: 'Developer', task: 'Watch mode implementation', outcome: 'success', tier: 'standard', mechanism: 'background', phase: 2, model: 'claude-sonnet-4-6' },
    { dayIdx: 38, hour: 8, agent: 'DevOps Expert', task: 'nx build caching config', outcome: 'partial', tier: 'standard', mechanism: 'background', phase: 2, convoy_id: 'demo-deploy-ci', model: 'claude-sonnet-4-6' },
    { dayIdx: 39, hour: 9, agent: 'Developer', task: 'Agents CLI command', outcome: 'success', tier: 'standard', mechanism: 'sub-agent', phase: 2, model: 'claude-sonnet-4-6' },
    { dayIdx: 39, hour: 11, agent: 'Reviewer', task: 'Agents CLI fast review', outcome: 'success', tier: 'utility', mechanism: 'sub-agent', phase: 4, model: 'claude-haiku-3-5' },
  ]

  for (const d of delegations) {
    emit({
      type: 'delegation',
      timestamp: dayTs(d.dayIdx, d.hour, (d.dayIdx * 5 + d.hour) % 55 + 2),
      agent: d.agent, task: d.task, outcome: d.outcome,
      tier: d.tier, mechanism: d.mechanism, phase: d.phase, model: d.model,
      ...(d.convoy_id ? { convoy_id: d.convoy_id } : {}),
    })
  }

  // ── Panel records ───────────────────────────────────────────────────
  const panels = [
    { dayIdx: 2, hour: 11, key: 'auth-security-panel', verdict: 'pass', pass: 3, block: 0, mustFix: 0, shouldFix: 1, attempt: 1, convoyId: 'demo-auth-revamp' },
    { dayIdx: 7, hour: 10, key: 'dashboard-ui-panel', verdict: 'block', pass: 2, block: 1, mustFix: 0, shouldFix: 3, attempt: 1, convoyId: 'demo-dashboard-ui' },
    { dayIdx: 7, hour: 11, key: 'dashboard-ui-panel', verdict: 'pass', pass: 3, block: 0, mustFix: 0, shouldFix: 2, attempt: 2, convoyId: 'demo-dashboard-ui' },
    { dayIdx: 11, hour: 17, key: 'api-security-panel', verdict: 'block', pass: 1, block: 2, mustFix: 2, shouldFix: 1, attempt: 1, convoyId: 'demo-api-v2' },
    { dayIdx: 13, hour: 15, key: 'api-security-panel-retry', verdict: 'pass', pass: 3, block: 0, mustFix: 0, shouldFix: 1, attempt: 2, convoyId: 'demo-api-v2' },
    { dayIdx: 16, hour: 12, key: 'perf-quality-panel', verdict: 'pass', pass: 3, block: 0, mustFix: 0, shouldFix: 0, attempt: 1, convoyId: 'demo-perf-opt' },
    { dayIdx: 21, hour: 15, key: 'etl-review-panel', verdict: 'pass', pass: 2, block: 1, mustFix: 0, shouldFix: 2, attempt: 1, convoyId: 'demo-data-pipeline' },
    { dayIdx: 27, hour: 16, key: 'docs-panel', verdict: 'pass', pass: 3, block: 0, mustFix: 0, shouldFix: 1, attempt: 1, convoyId: 'demo-docs-update' },
    { dayIdx: 33, hour: 16, key: 'ci-security-panel', verdict: 'pass', pass: 2, block: 1, mustFix: 1, shouldFix: 0, attempt: 1 },
    { dayIdx: 38, hour: 13, key: 'deploy-final-panel', verdict: 'block', pass: 1, block: 2, mustFix: 1, shouldFix: 2, attempt: 1, convoyId: 'demo-deploy-ci' },
  ]

  for (const p of panels) {
    emit({
      type: 'panel',
      timestamp: dayTs(p.dayIdx, p.hour, 15),
      panel_key: p.key, verdict: p.verdict,
      pass_count: p.pass, block_count: p.block,
      must_fix: p.mustFix, should_fix: p.shouldFix,
      reviewer_model: 'claude-opus-4-6',
      attempt: p.attempt, artifacts_count: p.verdict === 'pass' ? p.pass + 1 : 0,
      ...(p.convoyId ? { convoy_id: p.convoyId } : {}),
    })
  }

  // ── Review records ──────────────────────────────────────────────────
  const reviews = [
    { dayIdx: 2, hour: 11, agent: 'Reviewer', verdict: 'pass', critical: 0, major: 1, minor: 2, confidence: 'high', attempt: 1, escalated: false, issue: 'TASK-07', convoyId: 'demo-auth-revamp' },
    { dayIdx: 7, hour: 10, agent: 'Reviewer', verdict: 'block', critical: 0, major: 2, minor: 3, confidence: 'medium', attempt: 1, escalated: true, issue: 'TASK-18', convoyId: 'demo-dashboard-ui' },
    { dayIdx: 7, hour: 11, agent: 'Reviewer', verdict: 'pass', critical: 0, major: 0, minor: 2, confidence: 'high', attempt: 2, escalated: false, issue: 'TASK-18', convoyId: 'demo-dashboard-ui' },
    { dayIdx: 11, hour: 17, agent: 'Reviewer', verdict: 'block', critical: 2, major: 1, minor: 0, confidence: 'high', attempt: 1, escalated: true, issue: 'TASK-24', convoyId: 'demo-api-v2' },
    { dayIdx: 17, hour: 14, agent: 'Reviewer', verdict: 'pass', critical: 0, major: 0, minor: 1, confidence: 'high', attempt: 1, escalated: false, issue: 'TASK-33' },
    { dayIdx: 22, hour: 15, agent: 'Reviewer', verdict: 'pass', critical: 0, major: 0, minor: 0, confidence: 'high', attempt: 1, escalated: false, issue: 'TASK-40', convoyId: 'demo-data-pipeline' },
    { dayIdx: 35, hour: 10, agent: 'Reviewer', verdict: 'pass', critical: 0, major: 1, minor: 1, confidence: 'medium', attempt: 1, escalated: false, issue: 'TASK-53' },
    { dayIdx: 39, hour: 11, agent: 'Reviewer', verdict: 'pass', critical: 0, major: 0, minor: 1, confidence: 'high', attempt: 1, escalated: false, issue: 'TASK-61' },
  ]

  for (const r of reviews) {
    emit({
      type: 'review',
      timestamp: dayTs(r.dayIdx, r.hour, 25),
      agent: r.agent, verdict: r.verdict,
      issues_critical: r.critical, issues_major: r.major, issues_minor: r.minor,
      confidence: r.confidence, attempt: r.attempt, escalated: r.escalated,
      tracker_issue: r.issue,
      ...(r.convoyId ? { convoy_id: r.convoyId } : {}),
    })
  }

  writeFileSync(eventsPath, lines.join('\n') + '\n', 'utf8')
  console.log(`Generated demo events at ${eventsPath} (${lines.length} records)`)
}

// CLI entry (ESM-safe)
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] != null && resolve(process.argv[1]) === __filename) {
  const outArgIndex = process.argv.indexOf('--out')
  const out = outArgIndex >= 0 && process.argv[outArgIndex + 1]
    ? process.argv[outArgIndex + 1]
    : '.opencastle/convoy-demo.db'
  const eventsArgIndex = process.argv.indexOf('--events-out')
  const eventsOut = eventsArgIndex >= 0 && process.argv[eventsArgIndex + 1]
    ? process.argv[eventsArgIndex + 1]
    : '.opencastle/convoy-demo.events.ndjson'
  createDemoDb(out, eventsOut).catch(err => {
    console.error('Failed to create demo DB:', (err as Error).message)
    process.exit(1)
  })
}
