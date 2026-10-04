/*
 * OpenCastle Observability dashboard — the page's script.
 *
 * Reads the JSON API of `opencastle convoy dashboard` (live mode), or the same
 * responses saved under data/ by tools/dashboard-demo/export.mjs (static mode).
 * Every figure on the page is one the API returned: counts and sums of rows the
 * engine wrote. Nothing is estimated here. A value the API did not return is
 * shown as "not reported", never as 0.
 */
'use strict'

;(() => {
  const modeMeta = document.querySelector('meta[name="opencastle-dashboard"]')
  const LIVE = !modeMeta || modeMeta.getAttribute('content') !== 'static'
  const FAST_MS = 2000
  const SLOW_MS = 10000
  const EVENT_PAGE = 200
  const LIST_PAGE = 10
  const EXEC_PAGE = 10

  const FAILED = ['failed', 'gate-failed', 'timed-out', 'review-blocked', 'hook-failed', 'disputed']
  const RUNNING = ['running', 'assigned']
  const CATEGORY_LABELS = { run: 'Run', task: 'Tasks', check: 'Checks', review: 'Reviews', merge: 'Merge', other: 'Other' }
  const TIER_ORDER = ['premium', 'standard', 'utility', 'economy']

  const TASK_STATUS_TIPS = {
    done: 'Finished, and its work merged.',
    running: 'An agent is working on it now.',
    assigned: 'Given to a worker; starting.',
    pending: 'Waiting for what it depends on, or for a free slot.',
    failed: 'Stopped by an error, out of retries.',
    'gate-failed': "One of the task's gates failed, out of retries.",
    'timed-out': 'Ran past its time limit.',
    'review-blocked': 'A reviewer blocked the change, out of retries.',
    skipped: 'Never ran: something it depends on did not finish.',
    'hook-failed': 'A lifecycle script failed.',
    disputed: 'A review panel blocked it three times; see DISPUTES.md.',
    'wait-for-input': 'Paused until you answer.',
    interrupted: 'Recorded as running, but no process is working on it.',
  }

  const RUN_EXPLANATIONS = {
    running: 'A process is working on this run now.',
    pending: 'Started, waiting for its first task.',
    done: 'Every task finished and every check passed.',
    failed: 'At least one task did not finish.',
    'gate-failed': 'A check on the merged result failed.',
    'hook-failed': 'A lifecycle script failed.',
    interrupted: 'Stopped before it finished: Ctrl+C, a kill, or a crash. `opencastle convoy resume` continues it.',
  }

  const ICONS = {
    timeline: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="8" width="28" height="26" rx="3"/><line x1="6" y1="16" x2="34" y2="16"/><line x1="14" y1="8" x2="14" y2="12"/><line x1="26" y1="8" x2="26" y2="12"/></svg>',
    agents: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="20" cy="14" r="6"/><path d="M8 34c0-6.6 5.4-12 12-12s12 5.4 12 12"/></svg>',
    tiers: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="20" cy="10" rx="14" ry="5"/><path d="M6 10v8c0 2.8 6.3 5 14 5s14-2.2 14-5v-8"/><path d="M6 18v8c0 2.8 6.3 5 14 5s14-2.2 14-5v-8" opacity="0.5"/></svg>',
    mechanism: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="20" cy="20" r="6"/><path d="M20 6v6M20 28v6M6 20h6M28 20h6"/></svg>',
    models: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="24" height="24" rx="4"/><circle cx="20" cy="20" r="4"/></svg>',
    log: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8h18a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H14"/><circle cx="10" cy="14" r="3"/><circle cx="10" cy="24" r="3" opacity="0.4"/></svg>',
    review: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6l2 4h4l-3 3 1 5-4-2.5L16 18l1-5-3-3h4l2-4z"/><rect x="8" y="22" width="24" height="12" rx="3" opacity="0.4"/></svg>',
    table: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="28" height="28" rx="3"/><line x1="6" y1="14" x2="34" y2="14"/><line x1="14" y1="6" x2="14" y2="34" opacity="0.3"/></svg>',
    deps: '<svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="10" height="8" rx="2"/><rect x="26" y="24" width="10" height="8" rx="2"/><path d="M14 12c8 0 4 16 12 16"/></svg>',
  }

  const state = {
    project: '',
    generatedAt: null,
    runs: [],
    categories: {},
    overview: null,
    projects: 1,
    sessions: [],
    sessionsError: null,
    listError: null,
    view: 'home',
    selected: null,
    /** Show the run that is working now, and the next one when it starts. Off once the reader picks something. */
    follow: true,
    gen: 0,
    fastTimer: null,
    settling: false,
    run: null,
    insights: null,
    events: [],
    cursor: 0,
    more: false,
    eventsLoading: false,
    detailError: null,
    ui: {
      listPage: 1,
      chainOpen: new Set(),
      sortCol: 'started',
      sortAsc: true,
      execLimit: EXEC_PAGE,
      filter: 'all',
      eventOpen: new Set(),
      open: new Set(),
    },
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id)
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const pad = (n) => String(n).padStart(2, '0')
  const fileId = (id) => String(id).replace(/[^\w.-]/g, '_')
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const sum = (list, pick) => list.reduce((s, x) => s + (pick(x) || 0), 0)
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`

  function nr(label) {
    return `<span class="nr">${esc(label || 'not reported')}</span>`
  }

  function parseTime(iso) {
    const t = Date.parse(iso)
    return Number.isFinite(t) ? new Date(t) : null
  }

  function fmtClock(iso) {
    const d = parseTime(iso)
    return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '—'
  }

  function fmtDay(d) {
    const year = d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ''
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`
  }

  function fmtWhen(iso) {
    const d = parseTime(iso)
    return d ? `${fmtDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—'
  }

  function fmtWhenSec(iso) {
    const d = parseTime(iso)
    return d ? `${fmtDay(d)} ${fmtClock(iso)}` : '—'
  }

  function timeTag(iso, text) {
    return iso ? `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(text)}</time>` : '—'
  }

  function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null
    const s = Math.floor(ms / 1000)
    if (s < 1) return '<1s'
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${pad(s % 60)}s`
    return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
  }

  function since(iso) {
    const d = parseTime(iso)
    return d ? Date.now() - d.getTime() : null
  }

  function fmtTokens(n) {
    if (n == null) return null
    if (n < 1000) return String(n)
    if (n < 1e6) return `${(n / 1e3).toFixed(1)}K`
    return `${(n / 1e6).toFixed(2)}M`
  }

  function fmtCost(n, estimated) {
    if (n == null) return null
    const text = n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
    return estimated ? `${text}<span class="est" title="Part of this is an estimate: the runtime did not report it">est.</span>` : text
  }

  function fmtPct(x) {
    return x == null ? null : `${Math.round(x * 1000) / 10}%`
  }

  function tone(status) {
    if (status === 'done' || status === 'pass' || status === 'success' || status === 'passed') return 'tone-done'
    if (FAILED.includes(status) || status === 'block' || status === 'failed') return 'tone-failed'
    if (RUNNING.includes(status)) return 'tone-running'
    if (['interrupted', 'wait-for-input', 'skipped', 'partial', 'no verdict'].includes(status)) return 'tone-warn'
    if (status === 'auto-pass') return 'tone-review'
    return 'tone-muted'
  }

  function badge(status, title) {
    const tip = title ?? TASK_STATUS_TIPS[status] ?? ''
    return `<span class="status-badge ${tone(status)}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(status)}</span>`
  }

  function fillOf(status) {
    if (status === 'done') return 'fill-done'
    if (FAILED.includes(status)) return 'fill-failed'
    if (RUNNING.includes(status)) return 'fill-running'
    if (status === 'interrupted') return 'fill-interrupted'
    return 'fill-other'
  }

  function info(text) {
    return `<span class="tooltip-trigger" tabindex="0" role="note" aria-label="${esc(text)}" data-tooltip="${esc(text)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>`
  }

  function empty(icon, title, desc) {
    return `<div class="empty-state"><div class="empty-state__icon-wrap">${ICONS[icon] || ICONS.table}</div><p class="empty-state__title">${esc(title)}</p>${desc ? `<p class="empty-state__desc">${desc}</p>` : ''}</div>`
  }

  function card(label, value, opts = {}) {
    const shown = value == null ? nr(opts.missing) : value
    return `<div class="task-summary-card task-summary-card--${opts.mod || 'waiting'}">
      <span class="task-summary-card__label">${esc(label)}${opts.tip ? ` ${info(opts.tip)}` : ''}</span>
      <span class="task-summary-card__value">${shown}</span>
      ${opts.sub ? `<span class="task-summary-card__sub">${opts.sub}</span>` : ''}
    </div>`
  }

  function toggle(key, label) {
    const open = state.ui.open.has(key)
    return `<button type="button" class="toggle-btn" data-toggle="${esc(key)}" aria-expanded="${open}">${esc(label)}</button>`
  }

  function eventsMissing() {
    return empty('timeline', 'Not recorded', 'This database has no event table, so nothing derived from events is known for it.')
  }

  // ── data ───────────────────────────────────────────────────────────────────

  async function getJson(path) {
    const res = await fetch(path, { cache: 'no-store' })
    let body = null
    try {
      body = await res.json()
    } catch {
      // not JSON; the status says what went wrong
    }
    if (!res.ok) throw new Error((body && body.error) || `${res.status} ${res.statusText}`)
    return body || {}
  }

  const staticEvents = new Map()
  const api = LIVE
    ? {
        runs: () => getJson('api/runs'),
        run: (id) => getJson(`api/runs/${encodeURIComponent(id)}`),
        events: (id, after, limit) => getJson(`api/runs/${encodeURIComponent(id)}/events?since=${after}&limit=${limit}`),
        sessions: () => getJson('api/sessions'),
      }
    : {
        runs: () => getJson('data/runs.json'),
        run: (id) => getJson(`data/runs/${fileId(id)}.json`),
        // The snapshot holds every event in one file; it is paged here the way the API pages it.
        events: async (id, after, limit) => {
          let all = staticEvents.get(id)
          if (!all) {
            all = (await getJson(`data/events/${fileId(id)}.json`)).events || []
            staticEvents.set(id, all)
          }
          const rest = all.filter((e) => e.id > after)
          return { events: rest.slice(0, limit), more: rest.length > limit }
        },
        sessions: () => getJson('data/sessions.json'),
      }

  async function loadRuns() {
    const body = await api.runs()
    state.project = body.project || ''
    state.generatedAt = body.generated_at || null
    state.runs = body.runs || []
    state.categories = body.categories || {}
    state.overview = body.overview || null
    state.projects = body.projects || 1
    state.listError = null
  }

  async function loadSessions() {
    try {
      state.sessions = (await api.sessions()).sessions || []
      state.sessionsError = null
    } catch (err) {
      state.sessionsError = err.message
    }
    if (state.view === 'home') renderSessions()
  }

  // ── navigation ─────────────────────────────────────────────────────────────

  function hashRun() {
    const m = /^#run=(.+)$/.exec(location.hash)
    if (!m) return null
    try {
      return decodeURIComponent(m[1])
    } catch {
      return null
    }
  }

  function route() {
    const id = hashRun()
    if (id) {
      if (state.view !== 'detail' || state.selected !== id) openRun(id, false)
    } else if (state.view !== 'home') {
      showHome()
    }
  }

  function goHome() {
    state.follow = false
    if (location.hash) history.pushState(null, '', location.pathname + location.search)
    showHome()
  }

  function setViewVisibility(view) {
    $('view-home').toggleAttribute('data-view-hidden', view !== 'home')
    $('view-convoy-detail').toggleAttribute('data-view-hidden', view !== 'detail')
    $('breadcrumbs').toggleAttribute('data-view-hidden', view !== 'detail')
    document.querySelectorAll('.dash-sidebar__link').forEach((a) => {
      const li = a.closest('li')
      const hidden = a.dataset.view !== view || (a.id === 'panel-nav' && $('panel-section').hidden)
      li.hidden = hidden
    })
    if (window.scrollY < 40) activateFirstSection()
  }

  function showHome() {
    clearTimeout(state.fastTimer)
    state.gen++
    Object.assign(state, { view: 'home', selected: null, run: null, insights: null, events: [], cursor: 0, more: false, detailError: null })
    setViewVisibility('home')
    renderPicker()
    renderHome()
    renderNotices()
    renderFooter()
  }

  async function openRun(id, follow) {
    clearTimeout(state.fastTimer)
    const gen = ++state.gen
    Object.assign(state, {
      view: 'detail', selected: id, follow, run: null, insights: null, events: [], cursor: 0, more: false,
      detailError: null, settling: false,
    })
    Object.assign(state.ui, { filter: 'all', execLimit: EXEC_PAGE, sortCol: 'started', sortAsc: true })
    state.ui.eventOpen.clear()
    state.ui.open.clear()
    setViewVisibility('detail')
    renderPicker()
    renderDetail()
    window.scrollTo(0, 0)
    await loadDetail(gen, true)
  }

  /** Show the run a process is working on, without adding to the history. */
  function followRun(id) {
    history.replaceState(null, '', `${location.pathname}${location.search}#run=${encodeURIComponent(id)}`)
    openRun(id, true)
  }

  // ── polling ────────────────────────────────────────────────────────────────

  function appendEvents(page) {
    const fresh = page.events || []
    if (fresh.length) {
      state.events = state.events.concat(fresh)
      state.cursor = fresh[fresh.length - 1].id
    }
    state.more = Boolean(page.more)
  }

  /**
   * One read of the shown run: its detail, and — unless older events are still
   * waiting behind "Load more" — the events after the cursor. While the run is
   * alive this repeats every 2 seconds; once it stops, one last read picks up
   * what it wrote on the way out, and polling ends.
   */
  async function loadDetail(gen, initial) {
    const id = state.selected
    const wasAlive = Boolean(state.run && state.run.alive)
    try {
      const wantEvents = initial || !state.more
      const [detail, page] = await Promise.all([
        api.run(id),
        wantEvents ? api.events(id, state.cursor, EVENT_PAGE) : Promise.resolve(null),
      ])
      if (gen !== state.gen) return
      state.run = detail.run
      state.insights = detail.insights || null
      if (page) appendEvents(page)
      state.detailError = null
      syncListEntry(state.run)
      renderHeader()
      renderDetail()
    } catch (err) {
      if (gen !== state.gen) return
      state.detailError = err.message
      renderDetail()
    }
    if (gen !== state.gen || !LIVE) return
    const alive = Boolean(state.run && state.run.alive)
    if (alive || (state.detailError && !state.run)) {
      state.fastTimer = setTimeout(() => loadDetail(gen, false), state.detailError ? 5000 : FAST_MS)
    } else if (wasAlive && !state.settling) {
      state.settling = true
      state.fastTimer = setTimeout(() => loadDetail(gen, false), 600)
    }
  }

  function syncListEntry(run) {
    const i = state.runs.findIndex((r) => r.id === run.id)
    if (i === -1) return
    const { tasks, adapters, models, ...summary } = run
    state.runs[i] = { ...state.runs[i], ...summary }
  }

  async function loadMoreEvents() {
    if (state.eventsLoading || !state.more || !state.selected) return
    const gen = state.gen
    state.eventsLoading = true
    renderTimeline()
    try {
      const page = await api.events(state.selected, state.cursor, EVENT_PAGE)
      if (gen !== state.gen) return
      appendEvents(page)
    } catch (err) {
      state.detailError = `Could not read more events: ${err.message}`
      renderNotices()
    } finally {
      state.eventsLoading = false
      if (gen === state.gen) renderTimeline()
    }
  }

  /** Every 10 seconds: the run list, the totals and the sessions, and a run that started since. */
  async function slowTick() {
    try {
      await loadRuns()
    } catch (err) {
      state.listError = `Lost contact with the dashboard server (${err.message}). Retrying every 10 seconds.`
      renderNotices()
      return
    }
    loadSessions()
    renderPicker()
    renderHeader()
    if (state.view === 'home') renderHome()
    renderNotices()

    const working = state.runs.find((r) => r.alive)
    if (state.follow && working && working.id !== state.selected) return followRun(working.id)
    if (state.view !== 'detail' || !state.run) return
    const listed = state.runs.find((r) => r.id === state.selected)
    const shown = state.run
    if (listed && !shown.alive && (listed.alive || listed.status !== shown.status || listed.tasks_done !== shown.tasks_done || listed.finished_at !== shown.finished_at)) {
      clearTimeout(state.fastTimer)
      state.settling = false
      loadDetail(state.gen, false)
    }
  }

  // ── header, picker, notices, footer ────────────────────────────────────────

  function renderHeader() {
    $('project-name').textContent = state.project ? `· ${state.project}` : ''
    const badgeEl = $('source-badge')
    if (!LIVE) {
      badgeEl.className = 'source-badge'
      badgeEl.textContent = state.generatedAt ? `Snapshot · ${fmtWhen(state.generatedAt)}` : 'Snapshot'
      badgeEl.title = 'A static copy of recorded runs. Not live.'
      return
    }
    const working = state.runs.filter((r) => r.alive).length
    badgeEl.className = working ? 'source-badge source-badge--live' : 'source-badge'
    badgeEl.innerHTML = working ? `<span class="live-dot" aria-hidden="true"></span>${esc(plural(working, 'run'))} live` : 'Live · nothing running'
    badgeEl.title = 'Read from .opencastle/convoy.db on every refresh'
  }

  let pickerHtml = ''

  function renderPicker() {
    const sel = $('run-picker')
    const opts = ['<option value="">Overview of every run</option>']
    for (const r of state.runs.slice(0, 200)) {
      const label = `${r.name} · ${r.alive ? 'live' : r.display_status} · ${fmtWhen(r.started_at || r.created_at)}`
      opts.push(`<option value="${esc(r.id)}">${esc(label)}</option>`)
    }
    if (state.selected && !state.runs.some((r) => r.id === state.selected)) {
      opts.push(`<option value="${esc(state.selected)}">${esc(state.selected)}</option>`)
    }
    const html = opts.join('')
    // Rebuilding the options closes a list the reader has open; only do it when they changed.
    if (pickerHtml !== html) {
      sel.innerHTML = html
      pickerHtml = html
    }
    sel.value = state.view === 'detail' ? state.selected : ''
  }

  function renderNotices() {
    const notes = []
    if (state.listError) notes.push(`<p class="notice notice--error">${esc(state.listError)}</p>`)
    if (state.view === 'detail' && state.detailError && state.run) notes.push(`<p class="notice notice--error">${esc(state.detailError)}</p>`)
    $('notices').innerHTML = notes.join('')
  }

  function renderFooter() {
    $('footer').innerHTML = LIVE
      ? 'Read-only. Every figure is read from <code>.opencastle/convoy.db</code> and <code>.opencastle/logs/events.ndjson</code>. A live run refreshes every 2 seconds; the run list every 10.'
      : `A static snapshot of recorded runs${state.generatedAt ? `, exported ${esc(fmtWhen(state.generatedAt))}` : ''}. Every figure was read from the projects' own <code>.opencastle/convoy.db</code>. Not live.`
  }

  // ── shared charts ──────────────────────────────────────────────────────────

  function stackedBars(rows, segments) {
    const max = Math.max(1, ...rows.map((r) => r.total))
    return rows.map((r) => `<div class="bar-row">
      <span class="bar-label" title="${esc(r.label)}">${esc(r.label)}</span>
      <div class="bar-track" role="img" aria-label="${esc(`${r.label}: ${segments.filter((s) => r[s.key]).map((s) => `${r[s.key]} ${s.label}`).join(', ')}`)}">
        ${segments.filter((s) => r[s.key] > 0).map((s) => `<div class="bar-segment ${s.fill}" style="width:${((r[s.key] / max) * 100).toFixed(2)}%" title="${esc(`${s.label}: ${r[s.key]}`)}"></div>`).join('')}
      </div>
      <span class="bar-value">${r.total}</span>
    </div>`).join('')
  }

  function legend(segments) {
    return `<div class="legend-inline">${segments.map((s) => `<span><i class="swatch ${s.fill}"></i>${esc(s.label)}</span>`).join('')}</div>`
  }

  const AGENT_SEGMENTS = [
    { key: 'done', label: 'done', fill: 'fill-done' },
    { key: 'running', label: 'running', fill: 'fill-running' },
    { key: 'failed', label: 'failed', fill: 'fill-failed' },
    { key: 'other', label: 'other (pending, skipped, interrupted)', fill: 'fill-other' },
  ]

  function renderAgentChart(el, agents) {
    if (!agents.length) {
      el.innerHTML = empty('agents', 'No tasks recorded', 'Tasks per agent appear here once a run records tasks.')
      return
    }
    el.innerHTML = stackedBars(agents.map((a) => ({ ...a, label: a.agent })), AGENT_SEGMENTS) + legend(AGENT_SEGMENTS)
  }

  function agentsOf(tasks) {
    const map = new Map()
    for (const t of tasks) {
      const name = t.agent || 'not recorded'
      let a = map.get(name)
      if (!a) map.set(name, (a = { agent: name, total: 0, done: 0, failed: 0, running: 0, other: 0 }))
      a.total++
      const s = t.display_status
      if (s === 'done') a.done++
      else if (FAILED.includes(s)) a.failed++
      else if (RUNNING.includes(s)) a.running++
      else a.other++
    }
    return [...map.values()].sort((x, y) => y.total - x.total || x.agent.localeCompare(y.agent))
  }

  function simpleBars(rows, fill) {
    const max = Math.max(1, ...rows.map((r) => r.n))
    return rows.map((r) => `<div class="bar-row">
      <span class="bar-label" title="${esc(r.label)}">${r.labelHtml || esc(r.label)}</span>
      <div class="bar-track"><div class="bar-segment ${r.fill || fill}" style="width:${((r.n / max) * 100).toFixed(2)}%"></div></div>
      <span class="bar-value">${r.n}</span>
    </div>`).join('')
  }

  function renderModelChart(el, models, notReported, reviewModels) {
    const rows = models.map((m) => ({ label: m.model, n: m.tasks }))
    if (notReported > 0) rows.push({ label: 'not reported', labelHtml: nr(), n: notReported, fill: 'fill-unknown' })
    if (!rows.length) {
      el.innerHTML = empty('models', 'No tasks recorded', 'Tasks by the model their runtime reported appear here.')
      return
    }
    let html = simpleBars(rows, 'fill-accent')
    const reviewers = Object.entries(reviewModels || {}).sort((a, b) => b[1] - a[1])
    if (reviewers.length) {
      html += `<h3 class="section-subtitle">Reviews by reviewer model</h3>`
      html += simpleBars(reviewers.map(([model, n]) => (model === 'not reported' ? { label: model, labelHtml: nr(), n, fill: 'fill-unknown' } : { label: model, n })), 'fill-standard')
    }
    el.innerHTML = html
  }

  function donut(segments, totalLabel) {
    const total = segments.reduce((s, x) => s + x.n, 0)
    const r = 70
    const c = 2 * Math.PI * r
    let offset = 0
    const arcs = segments.map((s) => {
      const len = (s.n / total) * c
      const arc = `<circle cx="90" cy="90" r="${r}" fill="none" class="${s.fill}" style="stroke:var(${s.color})" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 90 90)"><title>${esc(`${s.label}: ${s.n}`)}</title></circle>`
      offset += len
      return arc
    })
    return `<div class="donut-wrap"><svg viewBox="0 0 180 180" class="donut-svg" role="img" aria-label="${esc(segments.map((s) => `${s.label} ${s.n}`).join(', '))}">
        <circle cx="90" cy="90" r="${r}" fill="none" class="donut-track" stroke-width="18"/>${arcs.join('')}</svg>
      <div class="donut-center"><span class="donut-total">${total}</span><span class="donut-total-label">${esc(totalLabel)}</span></div></div>`
  }

  function legendRows(segments, total) {
    return segments.map((s) => `<div class="legend-item"><i class="swatch ${s.fill}" style="background:var(${s.color})"></i><span class="legend-name">${s.labelHtml || esc(s.label)}</span><span class="legend-count">${s.n} (${Math.round((s.n / total) * 100)}%)</span></div>`).join('')
  }

  const TIER_COLOR = { premium: '--tier-premium', standard: '--tier-standard', utility: '--tier-utility', economy: '--tier-economy' }

  function renderTierChart(el, tiers, notRecorded, eventsRecorded) {
    if (eventsRecorded === false) {
      el.innerHTML = eventsMissing()
      return
    }
    const segs = [...tiers]
      .sort((a, b) => (TIER_ORDER.indexOf(a.tier) + 1 || 99) - (TIER_ORDER.indexOf(b.tier) + 1 || 99))
      .map((t) => ({ label: t.tier, n: t.tasks, color: TIER_COLOR[t.tier] || '--color-muted', fill: '' }))
    if (notRecorded > 0) segs.push({ label: 'not recorded', labelHtml: `${nr('not recorded')} ${info('Tasks with no delegation event: not finished yet, never run, or from an engine that wrote none.')}`, n: notRecorded, color: '--color-muted', fill: '' })
    if (!segs.length) {
      el.innerHTML = empty('tiers', 'No tiers recorded', 'Each task records its tier in a delegation event when it finishes.')
      return
    }
    const total = segs.reduce((s, x) => s + x.n, 0)
    el.innerHTML = `<div class="donut-container">${donut(segs, 'tasks')}<div class="donut-legend">${legendRows(segs, total)}</div></div>`
  }

  function renderMechanismChart(el, mechanisms, runtimes, eventsRecorded) {
    if (eventsRecorded === false) {
      el.innerHTML = eventsMissing()
      return
    }
    if (!mechanisms.length) {
      el.innerHTML = empty('mechanism', 'No attempts recorded', 'Each attempt records how it ran in its task_started event.')
      return
    }
    const colors = ['--accent-blue', '--accent-purple', '--color-partial', '--cat-merge', '--color-muted']
    const segs = mechanisms.map((m, i) => ({ label: m.mechanism === 'worktree' ? 'worktree (its own git worktree)' : m.mechanism, n: m.attempts, color: colors[i % colors.length], fill: '' }))
    const total = segs.reduce((s, x) => s + x.n, 0)
    const rt = runtimes.length
      ? `<div class="legend-group">Runtime</div>${runtimes.map((r) => `<div class="legend-item"><span class="legend-name">${esc(r.runtime)}</span><span class="legend-count">${r.attempts}</span></div>`).join('')}`
      : ''
    el.innerHTML = `<div class="donut-container">${donut(segs, 'attempts')}<div class="donut-legend">${legendRows(segs, total)}${rt}</div></div>`
  }

  // ── home ───────────────────────────────────────────────────────────────────

  function renderHome() {
    renderHeader()
    renderOverall()
    renderActivity()
    renderConvoyList()
    const o = state.overview
    if (o) {
      renderAgentChart($('home-agent-chart'), o.agents)
      renderModelChart($('home-model-chart'), o.models, o.models_not_reported, o.reviews ? o.reviews.models : null)
      renderTierChart($('home-tier-chart'), o.tiers, o.tiers_not_recorded, o.reviews !== null)
      renderMechanismChart($('home-mechanism-chart'), o.mechanisms, o.runtimes, o.reviews !== null)
      renderHomeQuality(o)
    }
    renderSessions()
  }

  function kpi(label, value, sub, tip) {
    return `<div class="overall-kpi">
      <span class="overall-kpi__label">${esc(label)}${tip ? ` ${info(tip)}` : ''}</span>
      <span class="overall-kpi__value">${value == null ? nr() : value}</span>
      ${sub ? `<span class="overall-kpi__sub">${sub}</span>` : ''}
    </div>`
  }

  function statusLine(byStatus) {
    return Object.entries(byStatus || {}).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${esc(s)}`).join(' · ')
  }

  function renderOverall() {
    const o = state.overview
    const grid = $('overall-grid')
    if (!o) {
      grid.innerHTML = state.listError ? '' : kpi('Total Runs', '…')
      return
    }
    const cost = o.cost
    const costSub = [
      cost.estimated === true ? 'includes estimates' : cost.estimated === false ? 'as the runtime reported' : '',
      cost.runs_not_reported ? `${plural(cost.runs_not_reported, 'run')} not reported` : '',
    ].filter(Boolean).join(' · ')
    $('overall-desc').innerHTML = state.projects > 1
      ? `Every convoy run recorded in these ${state.projects} projects' <code>.opencastle/convoy.db</code>.`
      : "Every convoy run recorded in this project's <code>.opencastle/convoy.db</code>."
    grid.innerHTML = [
      kpi('Total Runs', String(o.runs.total), statusLine(o.runs.by_status), 'Convoy runs recorded in this project'),
      kpi('Running Now', String(o.runs.alive), LIVE ? (o.runs.alive ? 'a process is working on it' : 'nothing running') : 'a snapshot is never live', 'Runs a live process is working on: a recent engine heartbeat and, on this machine, a live pid'),
      kpi('Total Tasks', String(o.tasks.total), statusLine(o.tasks.by_status)),
      kpi('Total Retries', String(o.tasks.retries), 'attempts after a task’s first'),
      kpi('Success Rate', fmtPct(o.runs.success_rate), o.runs.ended ? `${o.runs.done} done of ${plural(o.runs.ended, 'ended run')}` : 'no run has ended', 'Runs that ended done, out of every run that ended (done, failed, gate-failed, hook-failed or interrupted)'),
      kpi('Avg Duration', fmtDuration(o.duration.avg_ms), o.duration.measured ? `p95 ${esc(fmtDuration(o.duration.p95_ms))} · over ${plural(o.duration.measured, 'finished run')}` : 'no run has finished', 'Finished minus started, over runs that finished. A run resumed after an interrupt counts the time between.'),
      kpi('Total Tokens', o.tokens.total == null ? null : fmtTokens(o.tokens.total), o.tokens.runs_not_reported ? `${plural(o.tokens.runs_not_reported, 'run')} not reported` : 'every run reported', 'Tokens as each run recorded them: input, output and cache, plus reviews'),
      kpi('Total Cost', fmtCost(cost.total_usd, cost.estimated), costSub, 'Cost as the runtime reported it. Marked est. where any part had to be estimated.'),
    ].join('')
  }

  function renderActivity() {
    const el = $('activity-timeline-chart')
    const days = state.overview ? state.overview.activity : []
    if (!days.length) {
      el.innerHTML = empty('timeline', 'No runs yet', 'Runs per day appear here once the project has run a convoy.')
      return
    }
    const max = Math.max(1, ...days.map((d) => d.total))
    const segs = [
      { key: 'done', label: 'done', fill: 'fill-done' },
      { key: 'failed', label: 'failed', fill: 'fill-failed' },
      { key: 'interrupted', label: 'interrupted', fill: 'fill-interrupted' },
      { key: 'other', label: 'running or pending', fill: 'fill-running' },
    ]
    el.innerHTML = `<div class="activity-timeline--vertical">${days.map((d) => {
      const date = new Date(`${d.date}T00:00:00Z`)
      const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
      return `<div class="vbar-col" title="${esc(`${d.date}: ${segs.filter((s) => d[s.key]).map((s) => `${d[s.key]} ${s.label}`).join(', ')}`)}">
        <span class="vbar-value">${d.total}</span>
        <div class="vbar-track">${segs.filter((s) => d[s.key] > 0).map((s) => `<div class="vbar-fill ${s.fill}" style="height:${((d[s.key] / max) * 100).toFixed(2)}%"></div>`).join('')}</div>
        <span class="vbar-label">${label}</span>
      </div>`
    }).join('')}</div>${legend(segs)}`
  }

  function filteredRuns() {
    const q = $('cl-filter-search').value.trim().toLowerCase()
    const status = $('cl-filter-status').value
    const from = $('cl-filter-from').value
    const to = $('cl-filter-to').value
    return state.runs.filter((r) => {
      if (q && !`${r.name} ${r.id}`.toLowerCase().includes(q)) return false
      if (status && (r.alive ? 'live' : r.display_status) !== status) return false
      const day = String(r.created_at).slice(0, 10)
      if (from && day < from) return false
      if (to && day > to) return false
      return true
    })
  }

  function renderStatusFilter() {
    const sel = $('cl-filter-status')
    const current = sel.value
    const present = [...new Set(state.runs.map((r) => (r.alive ? 'live' : r.display_status)))].sort()
    if (current && !present.includes(current)) present.push(current)
    sel.innerHTML = '<option value="">All</option>' + present.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')
    sel.value = current
  }

  function runRow(r, cls) {
    const dur = r.duration_ms != null ? fmtDuration(r.duration_ms) : r.alive ? `${fmtDuration(since(r.started_at || r.created_at)) || '—'} so far` : null
    const tasks = `${r.tasks_done}/${r.tasks_total} done${r.tasks_failed ? ` · <span class="td-reason" style="display:inline">${r.tasks_failed} failed</span>` : ''}`
    const status = r.alive ? `${badge(r.status, 'A process is working on it now')}` : badge(r.display_status, r.display_status !== r.status ? `Recorded as ${r.status}; no process is working on it` : RUN_EXPLANATIONS[r.display_status])
    return `<tr data-run-id="${esc(r.id)}"${cls ? ` class="${cls}"` : ''}>
      <td class="card-key"><a class="run-link" href="#run=${encodeURIComponent(r.id)}">${esc(r.name)}</a><span class="td-sub">${esc(r.id)}</span></td>
      <td data-label="Status">${status}</td>
      <td data-label="Tasks">${tasks}</td>
      <td data-label="Started">${timeTag(r.started_at || r.created_at, fmtWhen(r.started_at || r.created_at))}</td>
      <td data-label="Duration" class="td-num">${dur == null ? '—' : esc(dur)}</td>
      <td data-label="Tokens" class="td-num">${r.tokens == null ? nr() : fmtTokens(r.tokens)}</td>
      <td data-label="Cost" class="td-num">${r.cost_usd == null ? nr() : fmtCost(r.cost_usd, r.cost_estimated)}</td>
    </tr>`
  }

  function renderConvoyList() {
    renderStatusFilter()
    const wrap = $('convoy-list-table-wrap')
    const pag = $('convoy-list-pagination')
    if (!state.runs.length) {
      wrap.innerHTML = `<div class="convoy-list-empty">${LIVE ? 'No convoy runs in this project yet. Start one with <code>opencastle convoy "&lt;task&gt;"</code>; it appears here within 10 seconds.' : 'This snapshot has no runs.'}</div>`
      pag.innerHTML = ''
      return
    }
    const runs = filteredRuns()
    if (!runs.length) {
      wrap.innerHTML = '<div class="convoy-list-empty">No runs match these filters.</div>'
      pag.innerHTML = ''
      return
    }
    // Runs of one pipeline are listed together, under the pipeline.
    const items = []
    const groups = new Map()
    for (const r of runs) {
      if (!r.pipeline_id) {
        items.push(r)
        continue
      }
      let g = groups.get(r.pipeline_id)
      if (!g) {
        groups.set(r.pipeline_id, (g = { pipeline_id: r.pipeline_id, runs: [] }))
        items.push(g)
      }
      g.runs.push(r)
    }
    const pages = Math.max(1, Math.ceil(items.length / LIST_PAGE))
    if (state.ui.listPage > pages) state.ui.listPage = pages
    const shown = items.slice((state.ui.listPage - 1) * LIST_PAGE, state.ui.listPage * LIST_PAGE)
    const rows = []
    for (const item of shown) {
      if (!item.runs) {
        rows.push(runRow(item))
        continue
      }
      const open = state.ui.chainOpen.has(item.pipeline_id)
      const done = item.runs.filter((r) => r.display_status === 'done').length
      const live = item.runs.some((r) => r.alive)
      rows.push(`<tr class="convoy-chain-row" data-pipeline-group-id="${esc(item.pipeline_id)}" aria-expanded="${open}">
        <td class="card-key"><span class="convoy-chain-toggle" aria-hidden="true">${open ? '▼' : '▶'}</span>Pipeline <code>${esc(item.pipeline_id)}</code></td>
        <td data-label="Status">${live ? badge('running', 'A run in this pipeline is working now') : `${done}/${item.runs.length} runs done`}</td>
        <td data-label="Tasks">${sum(item.runs, (r) => r.tasks_done)}/${sum(item.runs, (r) => r.tasks_total)} done</td>
        <td data-label="Runs">${plural(item.runs.length, 'run')}</td>
        <td class="td-num" data-label="Duration">—</td>
        <td class="td-num" data-label="Tokens">${item.runs.some((r) => r.tokens != null) ? fmtTokens(sum(item.runs, (r) => r.tokens)) : nr()}</td>
        <td class="td-num" data-label="Cost">${item.runs.some((r) => r.cost_usd != null) ? fmtCost(sum(item.runs, (r) => r.cost_usd), item.runs.some((r) => r.cost_estimated)) : nr()}</td>
      </tr>`)
      if (open) for (const r of item.runs) rows.push(runRow(r, 'convoy-chain-child'))
    }
    wrap.innerHTML = `<table class="convoy-list-table cards">
      <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Tasks</th><th scope="col">Started</th><th scope="col" class="td-num">Duration</th><th scope="col" class="td-num">Tokens</th><th scope="col" class="td-num">Cost</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>`
    pag.innerHTML = pages > 1
      ? `<div class="convoy-list-pagination">
          <button class="dash-btn dash-btn--ghost" type="button" data-page="${state.ui.listPage - 1}"${state.ui.listPage === 1 ? ' disabled' : ''}>Previous</button>
          <span class="convoy-list-pagination__info">Page ${state.ui.listPage} of ${pages} · ${plural(runs.length, 'run')}</span>
          <button class="dash-btn dash-btn--ghost" type="button" data-page="${state.ui.listPage + 1}"${state.ui.listPage === pages ? ' disabled' : ''}>Next</button>
        </div>`
      : ''
  }

  function renderHomeQuality(o) {
    const el = $('home-quality-body')
    const rv = o.reviews
    const ck = o.checks
    const cards = [
      card('Reviews run', rv ? String(rv.ran) : null, { mod: 'review', missing: 'not recorded', sub: rv ? `${rv.passed} passed · ${rv.blocked} blocked` : '', tip: 'Fast and panel reviews that reached a reviewer. Auto-passes are not counted here.' }),
      card('Blocked by review', rv ? String(rv.blocked) : null, { mod: 'errors', missing: 'not recorded', tip: 'Verdicts that sent a change back. The task retries with the reviewer’s issues if it has a retry left.' }),
      card('No verdict', rv ? String(rv.skipped) : null, { mod: 'input', missing: 'not recorded', tip: 'A review was due and reached no verdict: the work went unreviewed. Never counted as a pass.' }),
      card('Auto-passed', rv ? String(rv.auto_pass) : null, { mod: 'waiting', missing: 'not recorded', tip: 'Passed without a reviewer: a writer’s change, or a small one. No reviewer read it.' }),
      card('Review tokens', rv ? fmtTokens(rv.tokens) : null, { mod: 'review', missing: 'not recorded' }),
      card('Checks run', ck ? String(ck.ran) : null, { mod: 'done', missing: 'not recorded', sub: ck ? `${ck.passed} passed · ${ck.failed} failed` : '', tip: 'Spec gates and built-in gates, per task and on the merged result' }),
      card('Warnings', ck ? String(ck.warnings) : null, { mod: 'input', missing: 'not recorded', tip: 'Contract and file-partition violations: recorded, and the work kept' }),
      card('Retry queue', o.dlq ? String(o.dlq.entries) : null, { mod: o.dlq && o.dlq.unresolved ? 'errors' : 'done', missing: 'not recorded', sub: o.dlq ? `${o.dlq.unresolved} unresolved` : '', tip: 'Dead-letter queue: tasks that failed for good' }),
      card('Artifacts', o.artifacts == null ? null : String(o.artifacts), { mod: 'waiting', missing: 'not recorded' }),
    ]
    el.innerHTML = `<div class="task-summary-cards">${cards.join('')}</div>`
  }

  function sessionsTable(rows, withSource) {
    return `<div class="table-wrap"><table class="sessions-table cards">
      <thead><tr>${withSource ? '<th scope="col">Source</th>' : ''}<th scope="col">When</th><th scope="col">Task</th><th scope="col">Agent</th><th scope="col">Outcome</th><th scope="col" class="td-num">Minutes</th><th scope="col" class="td-num">Files</th><th scope="col" class="td-num">Retries</th><th scope="col">Model</th></tr></thead>
      <tbody>${rows.map((s) => {
        const src = `<span class="kind-badge" title="The engine's session event for a finished task">convoy run</span>${s.convoy_id ? `<span class="td-sub"><a href="#run=${encodeURIComponent(s.convoy_id)}" title="${esc(s.convoy_id)}">${esc(runName(s.convoy_id))}</a></span>` : ''}`
        const num = (v) => (v == null ? nr() : esc(v))
        return `<tr>
          ${withSource ? `<td data-label="Source">${src}</td>` : ''}
          <td data-label="When" class="td-nowrap">${timeTag(s.timestamp, fmtWhen(s.timestamp))}</td>
          <td class="card-key td-task">${s.task ? esc(s.task) : nr()}${s.tracker_issue ? `<span class="td-sub">${esc(s.tracker_issue)}</span>` : ''}</td>
          <td data-label="Agent">${s.agent ? esc(s.agent) : nr()}</td>
          <td data-label="Outcome">${s.outcome ? `<span class="outcome-badge ${tone(s.outcome)}">${esc(s.outcome)}</span>` : nr()}</td>
          <td data-label="Minutes" class="td-num">${num(s.duration_min)}</td>
          <td data-label="Files" class="td-num">${num(s.files_changed)}</td>
          <td data-label="Retries" class="td-num">${num(s.retries)}</td>
          <td data-label="Model">${s.model ? esc(s.model) : nr()}</td>
        </tr>`
      }).join('')}</tbody></table></div>`
  }

  function runName(id) {
    const run = state.runs.find((r) => r.id === id)
    return run ? run.name : id
  }

  function renderSessions() {
    const el = $('sessions-table')
    if (state.sessionsError) {
      el.innerHTML = `<p class="notice notice--error" style="margin:16px 24px">Could not read sessions: ${esc(state.sessionsError)}</p>`
      return
    }
    if (!state.sessions.length) {
      el.innerHTML = `<div style="padding:16px 24px">${empty('table', 'No sessions recorded yet', 'A convoy run records one per task it finishes.')}</div>`
      return
    }
    el.innerHTML = sessionsTable(state.sessions.slice(0, 20), true)
  }

  // ── detail ─────────────────────────────────────────────────────────────────

  function renderDetail() {
    renderNotices()
    renderFooter()
    const run = state.run
    const hero = $('convoy-detail-hero')
    $('breadcrumbs-run').textContent = run ? run.name : state.selected || ''
    if (!run) {
      hero.innerHTML = state.detailError
        ? `<p class="notice notice--error">Could not read run <code>${esc(state.selected)}</code>: ${esc(state.detailError)}</p>`
        : '<p class="muted">Loading…</p>'
      for (const id of ['task-summary-cards', 'task-table-wrap', 'deps-view', 'agent-chart', 'model-chart', 'tier-chart', 'mechanism-chart', 'quality-body', 'reviews-table', 'reliability-body', 'checks-body', 'outputs-body', 'event-timeline-filters', 'event-timeline-list', 'event-timeline-more', 'execution-log', 'detail-sessions-table']) $(id).innerHTML = ''
      return
    }
    const ins = state.insights
    renderHero(run, ins)
    renderTasks(run, ins)
    renderDeps(run)
    renderAgentChart($('agent-chart'), agentsOf(run.tasks))
    renderModelChart($('model-chart'), modelsOf(run.tasks), run.tasks.filter((t) => !t.model).length, ins ? ins.review_stats.models : null)
    if (ins) {
      renderTierChart($('tier-chart'), ins.tiers, ins.tiers_not_recorded, ins.events_recorded)
      renderMechanismChart($('mechanism-chart'), ins.mechanisms, ins.runtimes, ins.events_recorded)
    }
    renderQuality(run, ins)
    renderFastReviews(run, ins)
    renderPanels(ins)
    renderReliability(run, ins)
    renderChecks(ins)
    renderOutputs(run, ins)
    renderTimeline()
    renderExecLog(run, ins)
    renderDetailSessions(ins)
    setViewVisibility('detail')
  }

  function modelsOf(tasks) {
    const map = new Map()
    for (const t of tasks) if (t.model) map.set(t.model, (map.get(t.model) || 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([model, tasks]) => ({ model, tasks }))
  }

  function metaItem(label, value) {
    return `<div class="convoy-detail-hero__meta-item"><span class="convoy-detail-hero__meta-label">${esc(label)}</span><span class="convoy-detail-hero__meta-value">${value}</span></div>`
  }

  function renderHero(run, ins) {
    const shown = run.display_status
    const live = LIVE && run.alive
      ? '<span class="status-badge tone-running" title="A process is working on this run now"><span class="live-dot" aria-hidden="true" style="margin-right:6px"></span>live</span>'
      : ''
    const explanation = shown !== run.status
      ? `Recorded as <b>${esc(run.status)}</b>, but no process is working on it: it was interrupted. <code>opencastle convoy resume</code> continues it.`
      : esc(RUN_EXPLANATIONS[shown] || '').replace(/`([^`]+)`/g, '<code>$1</code>')
    const interrupts = ins ? ins.interruptions.filter((i) => i.type === 'convoy_interrupted').length : 0
    const resumes = ins ? ins.interruptions.filter((i) => i.type === 'convoy_resumed').length : 0
    const history = interrupts || resumes
      ? `<p class="convoy-status-explanation">Interrupted ${plural(interrupts, 'time')} and resumed ${plural(resumes, 'time')}; the duration includes the time between.</p>`
      : ''
    const elapsed = run.duration_ms != null
      ? esc(fmtDuration(run.duration_ms))
      : run.alive ? `<span data-elapsed-since="${esc(run.started_at || run.created_at)}">${esc(fmtDuration(since(run.started_at || run.created_at)) || '—')}</span> so far` : nr('not finished')
    const failed = run.tasks_failed ? ` · <span class="td-reason" style="display:inline">${run.tasks_failed} failed</span>` : ''
    const running = run.tasks_running && run.alive ? ` · ${run.tasks_running} running` : ''
    const chain = run.pipeline_id ? state.runs.filter((r) => r.pipeline_id === run.pipeline_id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))) : []
    const chainHtml = chain.length > 1
      ? `<div class="pipeline-chain-nav"><span class="pipeline-chain__label">Pipeline</span>${chain.map((r) => `<a class="pipeline-chain__item${r.id === run.id ? ' pipeline-chain__item--active' : ''}" href="#run=${encodeURIComponent(r.id)}"><i class="swatch ${fillOf(r.display_status)}"></i>${esc(r.name)}</a>`).join('')}</div>`
      : ''
    $('convoy-detail-hero').innerHTML = `
      <div class="convoy-detail-hero__top">
        <div style="min-width:0">
          <h2 class="convoy-detail-hero__title">${esc(run.name)}</h2>
          <div class="convoy-detail-hero__id"><code>${esc(run.id)}</code>${run.pipeline_id ? ` · pipeline <code>${esc(run.pipeline_id)}</code>` : ''}</div>
        </div>
        <div class="convoy-detail-hero__badges">${badge(shown, RUN_EXPLANATIONS[shown])}${live}</div>
      </div>
      <p class="convoy-status-explanation">${explanation}</p>${history}
      ${state.follow && LIVE ? `<p class="convoy-status-explanation muted">${run.alive ? 'Following this run while it works.' : 'This run has ended.'} A run that starts next opens here; pick another run, or the overview, to stop that.</p>` : ''}
      ${chainHtml}
      <div class="convoy-detail-hero__meta">
        ${metaItem('Branch', run.branch ? `<code>${esc(run.branch)}</code>` : '<span class="muted">current checkout</span>')}
        ${metaItem('Runtime', run.adapters.length ? esc(run.adapters.join(', ')) : nr('not recorded'))}
        ${metaItem('Models', run.models.length ? esc(run.models.join(', ')) : nr())}
        ${metaItem('Started', timeTag(run.started_at || run.created_at, fmtWhenSec(run.started_at || run.created_at)))}
        ${metaItem('Finished', run.finished_at ? timeTag(run.finished_at, fmtWhenSec(run.finished_at)) : nr('not finished'))}
        ${metaItem(run.alive ? 'Elapsed' : 'Duration', elapsed)}
        ${metaItem('Tasks', `${run.tasks_done}/${run.tasks_total} done${failed}${running}`)}
        ${metaItem('Tokens', run.tokens == null ? nr() : `${fmtTokens(run.tokens)}${run.alive ? ' <span class="muted">so far</span>' : ''}`)}
        ${metaItem('Cost', run.cost_usd == null ? nr() : fmtCost(run.cost_usd, run.cost_estimated))}
      </div>`
  }

  function taskDuration(t, run) {
    if (t.duration_ms != null) return fmtDuration(t.duration_ms)
    if (run.alive && RUNNING.includes(t.status) && t.started_at) return `<span data-elapsed-since="${esc(t.started_at)}">${esc(fmtDuration(since(t.started_at)) || '—')}</span> so far`
    return null
  }

  function tokensTip(t) {
    return [['prompt', t.prompt_tokens], ['completion', t.completion_tokens], ['cache read', t.cache_read_tokens], ['cache write', t.cache_write_tokens]]
      .filter(([, n]) => n != null).map(([k, n]) => `${k} ${Number(n).toLocaleString('en-US')}`).join(', ')
  }

  const TASK_COLS = [
    { key: 'id', label: 'Task', value: (t) => t.id },
    { key: 'agent', label: 'Agent', value: (t) => t.agent },
    { key: 'status', label: 'Status', value: (t) => t.display_status },
    { key: 'deps', label: 'Waits for', value: (t) => t.depends_on.length },
    { key: 'started', label: 'Started', value: (t) => t.started_at || '' },
    { key: 'duration', label: 'Duration', value: (t) => t.duration_ms ?? -1, num: true },
    { key: 'retries', label: 'Retries', value: (t) => t.retries, num: true },
    { key: 'changed', label: 'Files', title: 'Files the task changed, as its task_merged event recorded', value: (t) => (state.insights && t.id in state.insights.merges ? state.insights.merges[t.id] : -1), num: true },
    { key: 'tokens', label: 'Tokens', value: (t) => t.total_tokens ?? -1, num: true },
    { key: 'cost', label: 'Cost', value: (t) => t.cost_usd ?? -1, num: true },
  ]

  function renderTasks(run, ins) {
    const tasks = run.tasks
    const count = (pick) => tasks.filter((t) => pick(t.display_status)).length
    const cards = [
      card('Tasks Completed', String(count((s) => s === 'done')), { mod: 'done', tip: 'Finished, and their work merged' }),
      card('Tasks Running', String(count((s) => RUNNING.includes(s))), { mod: 'running', tip: 'An agent is working on them now' }),
      card('Tasks Waiting', String(count((s) => s === 'pending')), { mod: 'waiting', tip: 'Waiting for what they depend on, or for a free slot' }),
      card('Tasks With Errors', String(count((s) => FAILED.includes(s))), { mod: 'errors', tip: 'Failed for good: out of retries' }),
    ]
    const skipped = count((s) => s === 'skipped')
    const interrupted = count((s) => s === 'interrupted')
    const input = count((s) => s === 'wait-for-input')
    if (skipped) cards.push(card('Skipped', String(skipped), { mod: 'input', tip: 'Never ran: something they depend on did not finish' }))
    if (interrupted) cards.push(card('Interrupted', String(interrupted), { mod: 'input', tip: 'Recorded as running, but no process is working on them' }))
    if (input) cards.push(card('Waiting For Input', String(input), { mod: 'input' }))
    $('task-summary-cards').innerHTML = cards.join('')

    const wrap = $('task-table-wrap')
    if (!tasks.length) {
      wrap.innerHTML = empty('table', 'No tasks', 'This run has no tasks recorded.')
      return
    }
    const col = TASK_COLS.find((c) => c.key === state.ui.sortCol) || TASK_COLS[4]
    const dir = state.ui.sortAsc ? 1 : -1
    const sorted = tasks.map((t, i) => ({ t, i })).sort((a, b) => {
      const av = col.value(a.t)
      const bv = col.value(b.t)
      if (col.key === 'started') {
        // Not started yet sorts last either way.
        if (!av !== !bv) return av ? -1 : 1
      }
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir || a.i - b.i
    }).map((x) => x.t)
    const head = TASK_COLS.map((c) => {
      const active = c.key === col.key
      return `<th scope="col" class="sortable-th${active ? ' sortable-th--active' : ''}${c.num ? ' td-num' : ''}" aria-sort="${active ? (state.ui.sortAsc ? 'ascending' : 'descending') : 'none'}"${c.title ? ` title="${esc(c.title)}"` : ''}><button type="button" data-sort="${c.key}">${esc(c.label)}<span class="sort-indicator">${active ? (state.ui.sortAsc ? '▲' : '▼') : '↕'}</span></button></th>`
    }).join('')
    const body = sorted.map((t) => {
      const reason = FAILED.includes(t.display_status) && t.failure_reason ? `<span class="td-reason">${esc(t.failure_reason)}</span>` : ''
      const review = t.review_verdict === 'skipped' ? '<span class="td-sub">review: no verdict</span>' : ''
      const changed = ins && t.id in ins.merges ? String(ins.merges[t.id]) : null
      const dur = taskDuration(t, run)
      const tip = tokensTip(t)
      return `<tr>
        <td class="card-key td-task"><code>${esc(t.id)}</code></td>
        <td data-label="Agent">${esc(t.agent)}</td>
        <td data-label="Status">${badge(t.display_status)}${reason}${review}</td>
        <td data-label="Waits for">${t.depends_on.length ? t.depends_on.map((d) => `<code>${esc(d)}</code>`).join(', ') : '<span class="muted">nothing</span>'}</td>
        <td data-label="Started">${t.started_at ? timeTag(t.started_at, fmtClock(t.started_at)) : '<span class="muted">not started</span>'}</td>
        <td data-label="Duration" class="td-num">${dur ?? '—'}</td>
        <td data-label="Retries" class="td-num">${t.retries}</td>
        <td data-label="Files changed" class="td-num">${changed ?? '<span class="muted">not merged</span>'}</td>
        <td data-label="Tokens" class="td-num">${t.total_tokens == null ? nr() : `<span${tip ? ` title="${esc(tip)}"` : ''}>${fmtTokens(t.total_tokens)}</span>`}</td>
        <td data-label="Cost" class="td-num">${t.cost_usd == null ? nr() : fmtCost(t.cost_usd, t.cost_estimated)}</td>
      </tr>`
    }).join('')
    wrap.innerHTML = `<table class="sessions-table cards task-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }

  // ── dependency view ────────────────────────────────────────────────────────

  /** Depth from `depends_on`: 0 for a task that waits for nothing, else one more than the deepest task it waits for. */
  function depths(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const memo = new Map()
    const visiting = new Set()
    const depth = (id) => {
      if (memo.has(id)) return memo.get(id)
      if (visiting.has(id)) return 0
      visiting.add(id)
      const deps = (byId.get(id)?.depends_on || []).filter((d) => byId.has(d) && d !== id)
      const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0
      visiting.delete(id)
      memo.set(id, d)
      return d
    }
    for (const t of tasks) depth(t.id)
    return memo
  }

  const BLOCKING = new Set([...FAILED, 'skipped', 'interrupted'])

  function renderDeps(run) {
    const el = $('deps-view')
    const tasks = run.tasks
    if (!tasks.length) {
      el.innerHTML = empty('deps', 'No tasks', 'Tasks and what they wait for appear here.')
      return
    }
    const d = depths(tasks)
    const cols = []
    for (const t of tasks) (cols[d.get(t.id)] ||= []).push(t)
    const known = new Set(tasks.map((t) => t.id))
    const html = cols.map((list, depth) => {
      const rows = Math.min(list.length, 8)
      return `<div class="deps-col">
        <div class="deps-col__head">${depth === 0 ? 'Waits for nothing' : `Depth ${depth}`}</div>
        <div class="deps-col__nodes" style="grid-template-rows:repeat(${rows}, auto)">
          ${list.map((t) => {
            const missing = t.depends_on.filter((x) => !known.has(x))
            const tip = [`${t.id} — ${t.display_status}`, `agent: ${t.agent}`, t.depends_on.length ? `waits for: ${t.depends_on.join(', ')}` : 'waits for nothing', missing.length ? `not in this run: ${missing.join(', ')}` : ''].filter(Boolean).join('\n')
            const dur = taskDuration(t, run)
            return `<div class="dep-node ${tone(t.display_status)}" data-task="${esc(t.id)}" title="${esc(tip)}" tabindex="0">
              <span class="dep-node__id">${esc(t.id)}</span>
              <span class="dep-node__meta"><span>${esc(t.agent)}</span><span>${dur || esc(t.display_status)}</span></span>
            </div>`
          }).join('')}
        </div>
      </div>`
    }).join('')
    el.innerHTML = `<div class="deps-scroll"><div class="deps-canvas"><svg class="deps-edges" aria-hidden="true"></svg>${html}</div></div>
      ${legend([{ fill: 'fill-done', label: 'done' }, { fill: 'fill-running', label: 'running' }, { fill: 'fill-other', label: 'waiting' }, { fill: 'fill-failed', label: 'failed' }, { fill: 'fill-interrupted', label: 'skipped or interrupted' }])}`
    requestAnimationFrame(drawEdges)
  }

  function drawEdges() {
    const canvas = document.querySelector('.deps-canvas')
    const svg = canvas && canvas.querySelector('.deps-edges')
    if (!svg || !state.run) return
    const base = canvas.getBoundingClientRect()
    const vertical = getComputedStyle(canvas).flexDirection === 'column'
    const boxes = new Map([...canvas.querySelectorAll('.dep-node')].map((n) => [n.dataset.task, n.getBoundingClientRect()]))
    const status = new Map(state.run.tasks.map((t) => [t.id, t.display_status]))
    const paths = []
    for (const t of state.run.tasks) {
      for (const dep of t.depends_on) {
        const a = boxes.get(dep)
        const b = boxes.get(t.id)
        if (!a || !b) continue
        let p
        if (vertical) {
          const x1 = a.left + a.width / 2 - base.left
          const y1 = a.bottom - base.top
          const x2 = b.left + b.width / 2 - base.left
          const y2 = b.top - base.top
          const my = (y1 + y2) / 2
          p = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
        } else {
          const x1 = a.right - base.left
          const y1 = a.top + a.height / 2 - base.top
          const x2 = b.left - base.left
          const y2 = b.top + b.height / 2 - base.top
          const mx = (x1 + x2) / 2
          p = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
        }
        paths.push(`<path d="${p}" class="${BLOCKING.has(status.get(dep)) ? 'edge-blocked' : ''}"><title>${esc(`${t.id} waits for ${dep}`)}</title></path>`)
      }
    }
    svg.innerHTML = paths.join('')
  }

  // ── quality ────────────────────────────────────────────────────────────────

  function renderQuality(run, ins) {
    const el = $('quality-body')
    if (!ins || !ins.events_recorded) {
      el.innerHTML = eventsMissing()
      return
    }
    const s = ins.review_stats
    const cards = [
      card('Reviews run', String(s.ran), { mod: 'review', tip: 'Fast and panel reviews that reached a reviewer, every attempt counted' }),
      card('Passed', String(s.passed), { mod: 'done' }),
      card('Blocked', String(s.blocked), { mod: 'errors', tip: 'Sent back with the reviewer’s issues' }),
      card('No verdict', String(s.skipped), { mod: 'input', tip: 'A review was due and reached no verdict. The work went unreviewed; never a pass.' }),
      card('Auto-passed', String(s.auto_pass), { mod: 'waiting', tip: 'No reviewer read these: a writer’s change, or a small one' }),
      card('Review tokens', fmtTokens(s.tokens), { mod: 'review' }),
    ]
    if (s.disputes) cards.push(card('Disputes', String(s.disputes), { mod: 'errors', tip: 'A panel blocked the task three times' }))
    const parts = [`<div class="task-summary-cards">${cards.join('')}</div>`]
    const auto = ins.reviews.filter((r) => r.level === 'auto-pass')
    if (auto.length) {
      parts.push(`<h3 class="section-subtitle">Passed without a reviewer (auto-pass)</h3><ul class="plain-list">${auto.map((r) => `<li><code>${esc(r.task_id)}</code> — no reviewer read this change</li>`).join('')}</ul>`)
    }
    if (ins.reviews_skipped.length) {
      parts.push(`<h3 class="section-subtitle">Reviews that reached no verdict</h3><ul class="plain-list">${ins.reviews_skipped.map((r) => `<li><code>${esc(r.task_id)}</code> ${esc(r.level || '')} review${r.attempt ? `, attempt ${r.attempt}` : ''}: ${r.reason ? esc(r.reason) : nr('no reason recorded')}</li>`).join('')}</ul>`)
    }
    if (ins.disputes.length) {
      parts.push(`<h3 class="section-subtitle">Disputes</h3><ul class="plain-list">${ins.disputes.map((d) => `<li><code>${esc(d.task_id)}</code> ${esc(d.dispute_id || '')}: ${esc(d.reason || '')}</li>`).join('')}</ul>`)
    }
    if (!s.ran && !s.skipped && !auto.length) parts.push('<p class="reliability-empty">No review recorded in this run.</p>')
    el.innerHTML = parts.join('')
  }

  function renderFastReviews(run, ins) {
    const el = $('reviews-table')
    if (!ins || !ins.events_recorded) {
      el.innerHTML = `<div style="padding:0 24px 16px">${eventsMissing()}</div>`
      return
    }
    const rows = ins.reviews.filter((r) => r.level === 'fast')
    if (!rows.length) {
      el.innerHTML = `<div style="padding:0 24px 16px">${empty('review', 'No fast reviews', 'No single-reviewer review ran in this run.')}</div>`
      return
    }
    el.innerHTML = `<div class="table-wrap"><table class="sessions-table cards">
      <thead><tr><th scope="col">Task</th><th scope="col">Attempt</th><th scope="col">Verdict</th><th scope="col">Reviewer model</th><th scope="col" class="td-num">Tokens</th><th scope="col" class="td-num">Feedback</th><th scope="col">When</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="card-key td-task"><code>${esc(r.task_id)}</code></td>
        <td data-label="Attempt">${r.attempt ?? nr('not recorded')}</td>
        <td data-label="Verdict">${r.verdict ? badge(r.verdict, r.verdict === 'block' ? 'Sent back with the reviewer’s issues' : '') : nr()}</td>
        <td data-label="Reviewer model">${r.model ? esc(r.model) : nr()}</td>
        <td data-label="Tokens" class="td-num">${r.tokens == null ? nr() : fmtTokens(r.tokens)}</td>
        <td data-label="Feedback" class="td-num">${r.feedback_length == null ? nr() : `${r.feedback_length} chars`}</td>
        <td data-label="When">${timeTag(r.created_at, fmtClock(r.created_at))}</td>
      </tr>`).join('')}</tbody></table></div>`
  }

  function renderPanels(ins) {
    const section = $('panel-section')
    const rows = ins ? ins.reviews.filter((r) => r.level === 'panel') : []
    section.hidden = rows.length === 0
    if (!rows.length) {
      $('panel-chart').innerHTML = ''
      return
    }
    $('panel-chart').innerHTML = `<div class="panel-grid">${rows.map((r) => {
      const votes = r.passes == null && r.blocks == null
        ? nr('votes not recorded')
        : `${'<span class="panel-item__vote" title="pass">✓</span>'.repeat(r.passes || 0)}${'<span class="panel-item__vote panel-item__vote--block" title="block">✗</span>'.repeat(r.blocks || 0)}`
      return `<div class="panel-item">
        <div class="panel-item__header"><span class="panel-item__key" title="${esc(r.task_id)}">${esc(r.task_id)}</span>${badge(r.verdict || 'unknown')}</div>
        <div class="panel-item__votes">${votes}</div>
        <div class="panel-item__meta">
          <span>${r.model ? esc(r.model) : 'model not reported'}</span>
          <span>${r.tokens == null ? 'tokens not reported' : `${fmtTokens(r.tokens)} tokens`}</span>
          ${r.attempt ? `<span>attempt ${r.attempt}</span>` : ''}
        </div>
      </div>`
    }).join('')}</div>`
  }

  // ── reliability, checks, outputs ───────────────────────────────────────────

  function renderReliability(run, ins) {
    const tasks = run.tasks
    const done = tasks.filter((t) => t.display_status === 'done').length
    const dlq = ins ? ins.dlq : null
    const cards = [
      card('Retry Queue', dlq == null ? null : String(dlq.length), { mod: dlq && dlq.length ? 'errors' : 'done', missing: 'not recorded', tip: 'Dead-letter queue: tasks that failed for good, with their output' }),
      card('Total Retries', String(sum(tasks, (t) => t.retries)), { mod: 'running', tip: 'Attempts after a task’s first' }),
      card('Task Success Rate', tasks.length ? `${Math.round((done / tasks.length) * 100)}%` : null, { mod: 'done', missing: 'no tasks', sub: `${done} of ${plural(tasks.length, 'task')} done` }),
    ]
    const parts = [`<div class="task-summary-cards">${cards.join('')}</div>`]

    if (dlq && dlq.length) {
      parts.push(`<h3 class="section-subtitle">Retry queue</h3><div class="table-wrap"><table class="sessions-table cards">
        <thead><tr><th scope="col">Task</th><th scope="col">Agent</th><th scope="col">Failure</th><th scope="col" class="td-num">Attempts</th><th scope="col" class="td-num">Tokens spent</th><th scope="col">Resolved</th></tr></thead>
        <tbody>${dlq.map((d) => {
          const key = `dlq:${d.id}`
          const open = state.ui.open.has(key)
          return `<tr>
            <td class="card-key td-task"><code>${esc(d.task_id)}</code>${d.error_tail ? toggle(key, 'Output tail') : ''}${open && d.error_tail ? `<pre class="output-tail">${esc(d.error_tail)}</pre>` : ''}</td>
            <td data-label="Agent">${d.agent ? esc(d.agent) : nr()}</td>
            <td data-label="Failure">${d.failure_type ? esc(d.failure_type) : nr()}</td>
            <td data-label="Attempts" class="td-num">${d.attempts ?? nr()}</td>
            <td data-label="Tokens spent" class="td-num">${d.tokens_spent == null ? nr() : fmtTokens(d.tokens_spent)}</td>
            <td data-label="Resolved">${d.resolved ? `yes${d.resolution ? ` — ${esc(d.resolution)}` : ''}` : 'no'}</td>
          </tr>`
        }).join('')}</tbody></table></div>`)
    } else if (dlq) {
      parts.push('<p class="reliability-empty">The retry queue is empty: no task in this run failed for good.</p>')
    }

    if (ins && ins.retries.length) {
      parts.push(`<h3 class="section-subtitle">Retries</h3><div class="table-wrap"><table class="sessions-table cards">
        <thead><tr><th scope="col">When</th><th scope="col">Task</th><th scope="col">Next attempt</th><th scope="col">After</th><th scope="col">Why</th></tr></thead>
        <tbody>${ins.retries.map((r) => `<tr>
          <td data-label="When">${timeTag(r.created_at, fmtClock(r.created_at))}</td>
          <td class="card-key td-task"><code>${esc(r.task_id)}</code></td>
          <td data-label="Next attempt">${r.attempt ?? nr('not recorded')}</td>
          <td data-label="After">${r.previous_status ? badge(r.previous_status) : nr()}</td>
          <td data-label="Why" class="card-wide">${r.reason ? esc(r.reason) : '<span class="muted">reset by convoy resume</span>'}</td>
        </tr>`).join('')}</tbody></table></div>`)
    }

    const kinds = [
      ['failed', 'Failed'], ['gate-failed', 'Gate failed'], ['timed-out', 'Timed out'], ['review-blocked', 'Blocked by review'],
      ['hook-failed', 'Lifecycle script failed'], ['disputed', 'Disputed'], ['skipped', 'Skipped'], ['interrupted', 'Interrupted'],
    ].map(([key, label]) => ({ label, n: tasks.filter((t) => t.display_status === key).length, fill: key === 'skipped' || key === 'interrupted' ? 'fill-interrupted' : 'fill-failed' })).filter((k) => k.n > 0)
    parts.push('<h3 class="section-subtitle">Error overview</h3>')
    if (!kinds.length) {
      parts.push('<p class="reliability-empty">✓ No task in this run failed, was skipped or was left interrupted.</p>')
    } else {
      parts.push(simpleBars(kinds, 'fill-failed'))
      const reasons = tasks.filter((t) => t.failure_reason)
      if (reasons.length) parts.push(`<ul class="plain-list" style="margin-top:12px">${reasons.map((t) => `<li><code>${esc(t.id)}</code>: ${esc(t.failure_reason)}</li>`).join('')}</ul>`)
    }
    $('reliability-body').innerHTML = parts.join('')
  }

  function checkWhen(c) {
    if (c.scope === 'task') return c.attempt ? `attempt ${c.attempt}` : nr('not recorded')
    if (c.round == null) return nr('not recorded')
    return c.round === 1 ? 'round 1' : `round ${c.round} · after fix ${c.round - 1}`
  }

  function renderChecks(ins) {
    const el = $('checks-body')
    if (!ins || !ins.events_recorded) {
      el.innerHTML = eventsMissing()
      return
    }
    const s = ins.check_stats
    const parts = [`<div class="task-summary-cards">${[
      card('Checks run', String(s.ran), { mod: 'done', sub: `${s.gates.passed + s.gates.failed} spec gates · ${s.built_in.passed + s.built_in.failed} built-in` }),
      card('Passed', String(s.passed), { mod: 'done' }),
      card('Failed', String(s.failed), { mod: s.failed ? 'errors' : 'done' }),
      card('Warnings', String(s.warnings), { mod: 'input', tip: 'Contract and file-partition violations: recorded, and the work kept' }),
    ].join('')}</div>`]
    if (ins.checks.length) {
      parts.push(`<div class="table-wrap"><table class="sessions-table cards">
        <thead><tr><th scope="col">When</th><th scope="col">Check</th><th scope="col">Where</th><th scope="col">Attempt</th><th scope="col">Result</th><th scope="col" class="td-num">Exit code</th></tr></thead>
        <tbody>${ins.checks.map((c) => {
          const key = `check:${c.event_id}`
          const open = state.ui.open.has(key)
          const result = c.passed == null ? nr() : badge(c.passed ? 'passed' : 'failed', '')
          return `<tr>
            <td data-label="When">${timeTag(c.created_at, fmtClock(c.created_at))}</td>
            <td class="card-key td-task"><code>${esc(c.name)}</code> <span class="kind-badge">${c.kind === 'built-in' ? 'built-in' : 'spec gate'}</span>${c.level ? `<span class="td-sub">level ${esc(c.level)}</span>` : ''}${c.output ? toggle(key, 'Output') : ''}${open && c.output ? `<pre class="output-tail">${esc(c.output)}</pre>` : ''}</td>
            <td data-label="Where">${c.scope === 'task' ? `task <code>${esc(c.task_id)}</code>` : 'merged result'}</td>
            <td data-label="Attempt">${checkWhen(c)}</td>
            <td data-label="Result">${result}</td>
            <td data-label="Exit code" class="td-num">${c.exit_code == null ? '<span class="muted">—</span>' : c.exit_code}</td>
          </tr>`
        }).join('')}</tbody></table></div>`)
    } else {
      parts.push('<p class="reliability-empty">No check ran in this run. Checks are the spec’s <code>gates</code>, a task’s own <code>gates</code>, and the built-in gates a spec turns on.</p>')
    }
    if (ins.warnings.length) {
      parts.push(`<h3 class="section-subtitle">Warnings (the work was kept)</h3><ul class="plain-list">${ins.warnings.map((w) => `<li>${timeTag(w.created_at, fmtClock(w.created_at))} <code>${esc(w.task_id)}</code> <span class="kind-badge">${esc(w.type.replace(/_/g, ' '))}</span> ${w.items.length ? esc(w.items.join(', ')) : ''}</li>`).join('')}</ul>`)
    }
    if (ins.secrets_prevented.length) {
      parts.push(`<div class="secret-leak-banner"><span aria-hidden="true">⚠</span><div><strong>${plural(ins.secrets_prevented.length, 'secret')} masked or withheld.</strong> ${ins.secrets_prevented.map((x) => `${esc(x.context || 'unknown context')}${x.task_id ? ` (<code>${esc(x.task_id)}</code>)` : ''}`).join(', ')}</div></div>`)
    }
    el.innerHTML = parts.join('')
  }

  function renderOutputs(run, ins) {
    const el = $('outputs-body')
    const merges = ins ? ins.merges : {}
    const merged = Object.keys(merges).length
    const files = Object.values(merges).reduce((s, n) => s + n, 0)
    const artifacts = ins ? ins.artifacts : null
    const cards = [
      card('Tasks merged', ins && ins.events_recorded ? String(merged) : null, { mod: 'done', missing: 'not recorded', tip: 'Tasks whose commit merged into the run’s branch (task_merged)' }),
      card('Files changed', ins && ins.events_recorded ? String(files) : null, { mod: 'running', missing: 'not recorded', tip: 'Summed over merged tasks, as each task_merged recorded it' }),
      card('Artifacts', artifacts == null ? null : String(artifacts.length), { mod: 'waiting', missing: 'not recorded' }),
    ]
    const parts = [`<div class="task-summary-cards">${cards.join('')}</div>`]
    if (artifacts && artifacts.length) {
      parts.push(`<div class="table-wrap"><table class="sessions-table cards">
        <thead><tr><th scope="col">Artifact</th><th scope="col">Type</th><th scope="col">Task</th><th scope="col">Recorded</th></tr></thead>
        <tbody>${artifacts.map((a) => `<tr>
          <td class="card-key td-task"><code>${esc(a.name)}</code>${a.type !== 'file' && a.size_bytes != null ? `<span class="td-sub">${a.size_bytes.toLocaleString('en-US')} bytes</span>` : ''}</td>
          <td data-label="Type"><span class="kind-badge" title="${esc(a.type === 'file' ? 'A path from the task’s files' : 'What the agent answered')}">${esc(a.type)}</span></td>
          <td data-label="Task">${a.task_id ? `<code>${esc(a.task_id)}</code>` : nr()}</td>
          <td data-label="Recorded">${timeTag(a.created_at, fmtClock(a.created_at))}</td>
        </tr>`).join('')}</tbody></table></div>`)
    } else if (artifacts) {
      parts.push('<p class="reliability-empty">No artifacts recorded in this run.</p>')
    }
    el.innerHTML = parts.join('')
  }

  // ── event timeline ─────────────────────────────────────────────────────────

  function eventSummary(e) {
    const d = e.data
    if (d == null) return ''
    if (typeof d !== 'object') return esc(String(d).slice(0, 200))
    return Object.entries(d)
      .filter(([k, v]) => !(k === 'convoy_id' && v === state.selected) && !(k === 'task_id' && v === e.task_id) && v !== null && v !== '')
      .slice(0, 6)
      .map(([k, v]) => {
        let text = typeof v === 'object' ? (Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v)) : String(v)
        if (text.length > 90) text = `${text.slice(0, 87)}…`
        return `${esc(k)}=<b>${esc(text)}</b>`
      })
      .join(' ')
  }

  function eventMatches(e) {
    if (state.ui.filter === 'all') return true
    if (state.ui.filter === 'problem') return e.problem
    return e.category === state.ui.filter
  }

  function renderTimeline() {
    const filtersEl = $('event-timeline-filters')
    const listEl = $('event-timeline-list')
    const moreEl = $('event-timeline-more')
    if (!state.run) return
    if (state.insights && !state.insights.events_recorded) {
      filtersEl.innerHTML = ''
      listEl.innerHTML = eventsMissing()
      moreEl.innerHTML = ''
      return
    }
    const counts = { all: state.events.length, problem: 0 }
    for (const e of state.events) {
      counts[e.category] = (counts[e.category] || 0) + 1
      if (e.problem) counts.problem++
    }
    const chip = (key, label, title) => `<button type="button" class="timeline-filter-chip" data-filter="${esc(key)}" aria-pressed="${state.ui.filter === key}" title="${esc(title)}">${esc(label)} <span class="timeline-filter-chip__count">${counts[key] || 0}</span></button>`
    const chips = [chip('all', 'All', 'Every event loaded'), chip('problem', 'Problems', 'Failures, violations, conflicts, retries, interrupts, failed checks, blocked or unfinished reviews')]
    for (const [key, types] of Object.entries(state.categories)) {
      if ((types && types.length) || counts[key]) chips.push(chip(key, CATEGORY_LABELS[key] || key, (types || []).join(', ')))
    }
    filtersEl.innerHTML = chips.join('')

    const old = listEl.querySelector('.event-timeline-list')
    const scrollTop = old ? old.scrollTop : 0
    const atBottom = old ? old.scrollHeight - old.scrollTop - old.clientHeight < 40 : false
    const shown = state.events.filter(eventMatches)
    if (!shown.length) {
      listEl.innerHTML = empty('timeline', state.events.length ? 'No events in this group' : 'No events yet', state.events.length ? 'Pick another filter.' : 'Events appear here as the run writes them.')
    } else {
      listEl.innerHTML = `<div class="event-timeline-list">${shown.map((e) => {
        const open = state.ui.eventOpen.has(e.id)
        return `<div class="event-timeline-row${e.problem ? ' event-timeline-row--problem' : ''}">
          <button type="button" class="event-timeline-row__main" data-event="${e.id}" aria-expanded="${open}">
            <span class="event-timeline-ts" title="${esc(e.created_at)}">${esc(fmtWhenSec(e.created_at))}</span>
            <span class="event-type-badge cat-${esc(e.category)}">${esc(e.type)}</span>
            ${e.task_id ? `<span class="event-timeline-context">${esc(e.task_id)}</span>` : ''}
            ${e.problem ? '<span class="status-badge tone-failed">problem</span>' : ''}
            <span class="event-timeline-summary">${eventSummary(e)}</span>
          </button>
          ${open ? `<div class="event-timeline-detail"><pre class="event-timeline-json">${esc(JSON.stringify(e.data, null, 2))}</pre></div>` : ''}
        </div>`
      }).join('')}</div>`
      const list = listEl.querySelector('.event-timeline-list')
      list.scrollTop = atBottom && state.run.alive ? list.scrollHeight : scrollTop
    }
    const parts = [`${plural(state.events.length, 'event')} loaded`]
    if (state.more) parts.push(`<button type="button" class="dash-btn dash-btn--ghost" id="event-more-btn"${state.eventsLoading ? ' disabled' : ''}>${state.eventsLoading ? 'Loading…' : `Load ${EVENT_PAGE} more`}</button>`)
    else if (LIVE && state.run.alive) parts.push('new events appear as they are written')
    else parts.push('that is every event this run recorded')
    moreEl.innerHTML = parts.join(' · ')
  }

  // ── execution log ──────────────────────────────────────────────────────────

  const EXEC_ICON = { 'tone-done': '✓', 'tone-failed': '✗', 'tone-running': '▶', 'tone-warn': '‖', 'tone-muted': '○', 'tone-review': '○' }

  function renderExecLog(run, ins) {
    const el = $('execution-log')
    if (!run.tasks.length) {
      el.innerHTML = empty('log', 'No tasks', 'Each task appears here as it starts.')
      return
    }
    const started = run.tasks.filter((t) => t.started_at).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    const waiting = run.tasks.filter((t) => !t.started_at)
    const all = started.concat(waiting)
    const shown = all.slice(0, state.ui.execLimit)
    const tiers = ins ? ins.task_tiers : {}
    el.innerHTML = `<div class="exec-log">${shown.map((t) => {
      const tn = tone(t.display_status)
      const dur = taskDuration(t, run)
      const starts = ins && ins.starts[t.id] ? ins.starts[t.id] : 0
      const retries = ins ? ins.retries.filter((r) => r.task_id === t.id) : []
      const kills = ins ? ins.interruptions.filter((i) => i.type === 'worker_killed' && i.task_id === t.id) : []
      const key = `tail:${t.id}`
      const open = state.ui.open.has(key)
      const meta = [
        t.started_at ? `Started <b>${timeTag(t.started_at, fmtClock(t.started_at))}</b>` : 'Not started',
        t.finished_at ? `Finished <b>${timeTag(t.finished_at, fmtClock(t.finished_at))}</b>` : '',
        dur ? `Duration <b>${dur}</b>` : '',
        `Model <b>${t.model ? esc(t.model) : nr()}</b>`,
        starts > 1 ? `<b>${starts}</b> starts` : '',
        t.retries ? `<b>${t.retries}</b> ${t.retries === 1 ? 'retry' : 'retries'}` : '',
        t.total_tokens != null ? `Tokens <b>${fmtTokens(t.total_tokens)}</b>` : '',
        t.cost_usd != null ? `Cost <b>${fmtCost(t.cost_usd, t.cost_estimated)}</b>` : '',
      ].filter(Boolean)
      const notes = [
        ...kills.map((k) => `<div class="exec-step__note">Stopped by an interrupt at ${timeTag(k.created_at, fmtClock(k.created_at))}; started again on resume.</div>`),
        ...retries.map((r) => `<div class="exec-step__note">Retried${r.attempt ? ` as attempt ${r.attempt}` : ''} at ${timeTag(r.created_at, fmtClock(r.created_at))} after <b>${esc(r.previous_status || 'a failure')}</b>${r.reason ? `: ${esc(r.reason)}` : ''}</div>`),
      ]
      const failure = FAILED.includes(t.display_status)
        ? `<div class="td-reason">${t.failure_reason ? esc(t.failure_reason) : 'No reason recorded'}</div>${t.error_tail ? toggle(key, 'Output tail') : ''}${open && t.error_tail ? `<pre class="output-tail">${esc(t.error_tail)}</pre>` : ''}`
        : ''
      return `<div class="exec-step" id="exec-${esc(t.id)}">
        <div class="exec-step__indicator"><div class="exec-step__dot ${tn}">${EXEC_ICON[tn] || '○'}</div></div>
        <div class="exec-step__content">
          <div class="exec-step__header"><span class="exec-step__agent">${esc(t.agent)}</span>${badge(t.display_status)}${tiers[t.id] ? `<span class="kind-badge" title="Tier from the task's delegation event">${esc(tiers[t.id])}</span>` : ''}</div>
          <div class="exec-step__task"><code>${esc(t.id)}</code>${t.depends_on.length ? ` <span class="muted">waits for ${t.depends_on.map(esc).join(', ')}</span>` : ''}</div>
          <div class="exec-step__meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
          ${notes.join('')}${failure}
        </div>
      </div>`
    }).join('')}</div>${all.length > shown.length ? `<div style="text-align:center;padding-top:12px"><button class="dash-btn dash-btn--ghost" type="button" id="exec-more-btn">Show all ${all.length} tasks</button></div>` : ''}`
  }

  function renderDetailSessions(ins) {
    const el = $('detail-sessions-table')
    if (!ins || !ins.events_recorded) {
      el.innerHTML = `<div style="padding:0 24px 16px">${eventsMissing()}</div>`
      return
    }
    if (!ins.sessions.length) {
      el.innerHTML = `<div style="padding:0 24px 16px">${empty('table', 'No sessions yet', 'The engine writes one when each task finishes.')}</div>`
      return
    }
    el.innerHTML = sessionsTable(ins.sessions, false)
  }

  // ── export ─────────────────────────────────────────────────────────────────

  function exportJson() {
    const exportedAt = new Date().toISOString()
    const data = state.view === 'detail' && state.run
      ? { exported_at: exportedAt, source: LIVE ? 'live' : 'snapshot', project: state.project, run: state.run, insights: state.insights, events: state.events, events_complete: !state.more }
      : { exported_at: exportedAt, source: LIVE ? 'live' : 'snapshot', project: state.project, overview: state.overview, runs: state.runs, sessions: state.sessions }
    const name = state.view === 'detail' && state.run ? `opencastle-${fileId(state.run.id)}.json` : `opencastle-${fileId(state.project || 'dashboard')}-overview.json`
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  function onListFilter() {
    state.ui.listPage = 1
    renderConvoyList()
  }

  function wire() {
    $('export-btn').addEventListener('click', exportJson)
    $('run-picker').addEventListener('change', (e) => {
      state.follow = false
      const id = e.target.value
      if (id) location.hash = `run=${encodeURIComponent(id)}`
      else goHome()
    })
    $('breadcrumbs-home').addEventListener('click', (e) => {
      e.preventDefault()
      goHome()
    })
    for (const id of ['cl-filter-search', 'cl-filter-status', 'cl-filter-from', 'cl-filter-to']) {
      $(id).addEventListener(id === 'cl-filter-search' ? 'input' : 'change', onListFilter)
    }
    $('cl-filter-reset').addEventListener('click', () => {
      for (const id of ['cl-filter-search', 'cl-filter-status', 'cl-filter-from', 'cl-filter-to']) $(id).value = ''
      onListFilter()
    })
    $('convoy-list-table-wrap').addEventListener('click', (e) => {
      const group = e.target.closest('tr[data-pipeline-group-id]')
      if (group) {
        const id = group.dataset.pipelineGroupId
        if (state.ui.chainOpen.has(id)) state.ui.chainOpen.delete(id)
        else state.ui.chainOpen.add(id)
        renderConvoyList()
        return
      }
      const row = e.target.closest('tr[data-run-id]')
      if (!row) return
      state.follow = false
      if (e.target.closest('a')) return
      location.hash = `run=${encodeURIComponent(row.dataset.runId)}`
    })
    $('convoy-list-pagination').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]')
      if (!btn || btn.disabled) return
      state.ui.listPage = Number(btn.dataset.page)
      renderConvoyList()
    })
    document.addEventListener('click', (e) => {
      if (e.target.closest('a[href^="#run="]')) state.follow = false
    })
    $('view-convoy-detail').addEventListener('click', (e) => {
      const sortBtn = e.target.closest('button[data-sort]')
      if (sortBtn) {
        const key = sortBtn.dataset.sort
        if (state.ui.sortCol === key) state.ui.sortAsc = !state.ui.sortAsc
        else Object.assign(state.ui, { sortCol: key, sortAsc: true })
        renderTasks(state.run, state.insights)
        return
      }
      const tog = e.target.closest('button[data-toggle]')
      if (tog) {
        const key = tog.dataset.toggle
        if (state.ui.open.has(key)) state.ui.open.delete(key)
        else state.ui.open.add(key)
        renderDetail()
        return
      }
      const chip = e.target.closest('button[data-filter]')
      if (chip) {
        state.ui.filter = chip.dataset.filter
        renderTimeline()
        return
      }
      const ev = e.target.closest('button[data-event]')
      if (ev) {
        const id = Number(ev.dataset.event)
        if (state.ui.eventOpen.has(id)) state.ui.eventOpen.delete(id)
        else state.ui.eventOpen.add(id)
        renderTimeline()
        return
      }
      if (e.target.closest('#event-more-btn')) return void loadMoreEvents()
      if (e.target.closest('#exec-more-btn')) {
        state.ui.execLimit = Infinity
        renderExecLog(state.run, state.insights)
      }
    })
    window.addEventListener('hashchange', route)
    window.addEventListener('popstate', route)
    let resizeTimer = null
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(drawEdges, 100)
    })
    // Elapsed times of live runs and tasks tick every second between reads.
    setInterval(() => {
      document.querySelectorAll('[data-elapsed-since]').forEach((el) => {
        el.textContent = fmtDuration(since(el.dataset.elapsedSince)) || '—'
      })
    }, 1000)
    initSidebarNav()
  }

  function activate(id) {
    for (const link of document.querySelectorAll('.dash-sidebar__link')) link.classList.toggle('dash-sidebar__link--active', link.dataset.section === id)
  }

  /** At the top of the page the first section is the current one, whatever crosses the band below it. */
  function activateFirstSection() {
    const first = [...document.querySelectorAll('.dash-sidebar__link')].find((l) => !l.closest('li').hidden)
    if (first) activate(first.dataset.section)
  }

  function initSidebarNav() {
    const links = [...document.querySelectorAll('.dash-sidebar__link')]
    const observer = new IntersectionObserver((entries) => {
      if (window.scrollY < 40) return
      for (const entry of entries) if (entry.isIntersecting) activate(entry.target.id)
    }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 })
    window.addEventListener('scroll', () => {
      if (window.scrollY < 40) activateFirstSection()
    }, { passive: true })
    document.querySelectorAll('[data-nav-section]').forEach((s) => observer.observe(s))
    for (const link of links) {
      link.addEventListener('click', (e) => {
        e.preventDefault()
        const target = $(link.dataset.section)
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }

  async function boot() {
    renderFooter()
    try {
      await loadRuns()
    } catch (err) {
      state.listError = `Could not read runs: ${err.message}`
      renderNotices()
      renderHeader()
      if (LIVE) setTimeout(boot, SLOW_MS)
      return
    }
    renderHeader()
    renderPicker()
    loadSessions()
    // An old link with ?convoy=<id> opens that run.
    const legacy = new URLSearchParams(location.search).get('convoy')
    if (!hashRun() && legacy && legacy !== 'active') history.replaceState(null, '', `${location.pathname}#run=${encodeURIComponent(legacy)}`)
    const picked = hashRun()
    const working = LIVE ? state.runs.find((r) => r.alive) : null
    if (picked) {
      state.follow = false
      await openRun(picked, false)
    } else if (working) {
      followRun(working.id)
    } else {
      showHome()
    }
    if (LIVE) setInterval(slowTick, SLOW_MS)
  }

  wire()
  setViewVisibility('home')
  boot()
})()
