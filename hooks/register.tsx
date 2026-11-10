import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, Timer } from 'claude-code'

import type { View, Sess, Snapshot, Usage, Waiting, WaitReason } from '../types'
import { clawd, pulseDot, usageBar, type Mood } from './clawd'
import { stageSvg, stageText } from './stage'
import type { ShimmerProps } from './shimmer'

const PANE = 'session-following'
const SERVER = 'ccd_session_mgmt'
const RECENT_DAYS = 3
// projects with no activity for this long are folded and moved to the bottom
const STALE_DAYS = 7
const POLL_MS = 10000
const CHECK_MS = 4000
const IDLE_CACHE_MS = 120000
const SHIMMER_MAX = 4
const CHEER_MS = 10000
const FLAG_MAX_AGE_MS = 24 * 3600 * 1000
const EMPTY: Snapshot = { checkedAt: '', sessions: [], error: null, usage: [], cheerUntil: 0, cheerTitle: '' }
// Bump the tag when Snapshot changes: it declines what an earlier version stored.
const snap = atom({ plugin: 'session-following', key: 'snap' } as const, EMPTY, {
  shape: 'snap-4',
})
const PER_GROUP_DEFAULT = 5
const PER_GROUP_CHOICES = [3, 5, 10, 0]
const view = atom({ plugin: 'session-following', key: 'view' } as const, { perGroup: PER_GROUP_DEFAULT, expanded: [], collapsed: [] } as View, {
  shape: 'view-1',
})
const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter(x => x !== k) : [...list, k])

type Raw = {
  sessionId?: string
  title?: string
  cwd?: string
  isRunning?: boolean
  lastActivityAt?: string
  startedBy?: string
  parentSessionId?: string
  remoteControlActive?: boolean
  link?: string
}
type Obj = Record<string, unknown>

// Per-process memory (this session's own copy of the mod).
let selfId = ''
let polling = false
let lastPollAt = 0
let ticker: Timer | null = null
const prevRunning = new Map<string, boolean>()
type Detail = { model: string; effort: string; branch: string; perm: string }
const detailCache = new Map<string, { at: number; d: Detail }>()
const runStart = new Map<string, number>()
const activeWaits = new Set<string>()
let wrapAsk = ''

function textOf(res: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return res.content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
}

function toSess(r: Raw, isSelf: boolean): Sess {
  return {
    id: r.sessionId ?? '',
    title: r.title || '(untitled)',
    cwd: r.cwd ?? '',
    isRunning: !!r.isRunning,
    lastActivityAt: r.lastActivityAt ?? '',
    startedBy: r.startedBy ?? r.parentSessionId ?? null,
    remote: !!r.remoteControlActive,
    link: r.link ?? null,
    isSelf,
    model: '',
    effort: '',
    branch: '',
    perm: '',
    ctx: null,
    workingSince: 0,
    waiting: null,
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function callJson<T>($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await $.mcp.call(SERVER, tool, args)
    if (res.isError) return null
    return parseJson<T>(textOf(res))
  } catch {
    return null
  }
}

async function listSessions($: EngineInterface): Promise<Raw[]> {
  let last = ''
  for (const limit of [200, 100, 50]) {
    const res = await $.mcp.call(SERVER, 'list_sessions', { limit })
    const text = textOf(res)
    const rows = res.isError ? null : parseJson<Raw[]>(text)
    if (Array.isArray(rows)) return rows
    last = text
  }
  throw new Error(last.slice(0, 300))
}

// ---- placement: poll only while this session's pane is drawn -------------------
async function isPlaced($: EngineInterface): Promise<boolean> {
  try {
    const panes = await $.ui.panes()
    return panes.some(p => p.id === PANE && p.isPlaced)
  } catch {
    return false
  }
}

// ---- detail line ---------------------------------------------------------------
function shortModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id)
  if (!m) return id.replace(/^claude-/, '')
  const name = (m[1] ?? '').charAt(0).toUpperCase() + (m[1] ?? '').slice(1)
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

function branchOf(o: Obj): string {
  const direct = o.branch ?? o.gitBranch ?? o.worktreeBranch
  if (typeof direct === 'string' && direct) return direct
  const w = o.worktree
  if (isObj(w)) {
    const b = w.branch ?? w.name
    if (typeof b === 'string' && b) return `worktree ${b}`
  } else if (typeof w === 'string' && w) return `worktree ${w}`
  return ''
}

function detailOf(o: Obj): Detail {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return { model: str(o.model), effort: str(o.effort), branch: branchOf(o), perm: str(o.permissionMode) }
}

type UsageRes = {
  plan?: { status?: string; windows?: { label?: string; percentUsed?: number; resetsIn?: string }[] }
  context?: { status?: string; percentUsed?: number }
}

function planUsage(u: UsageRes | null): Usage[] {
  if (!u || !u.plan || u.plan.status !== 'ok' || !Array.isArray(u.plan.windows)) return []
  const out: Usage[] = []
  for (const w of u.plan.windows) {
    if (typeof w.label !== 'string' || typeof w.percentUsed !== 'number') continue
    out.push({ label: w.label, percent: Math.round(w.percentUsed), resetsIn: typeof w.resetsIn === 'string' ? w.resetsIn : '' })
  }
  return out
}

function ctxPercent(u: UsageRes | null): number | null {
  return u && u.context && u.context.status === 'ok' && typeof u.context.percentUsed === 'number' ? Math.round(u.context.percentUsed) : null
}

// ---- needs-you flags: one small JSON file per session ----------------------------
async function baseDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return home ? `${home}/.claude/session-following` : ''
}

let selfMode = ''
let selfModeAt = 0
async function getSelfMode($: EngineInterface): Promise<string> {
  if (Date.now() - selfModeAt < 60000) return selfMode
  const raw = await callJson<Obj>($, 'get_session', { session_id: 'self' })
  selfModeAt = Date.now()
  selfMode = raw && typeof raw.permissionMode === 'string' ? raw.permissionMode : ''
  return selfMode
}

async function getSelfId($: EngineInterface): Promise<string> {
  if (selfId) return selfId
  const raw = await callJson<Raw>($, 'get_session', { session_id: 'self' })
  if (raw && typeof raw.sessionId === 'string') selfId = raw.sessionId
  return selfId
}

async function writeFlag($: EngineInterface, w: Waiting | null): Promise<void> {
  try {
    const id = await getSelfId($)
    const dir = await baseDir($)
    if (!id || !dir) return
    const body = w ? { sessionId: id, ...w } : { sessionId: id, cleared: true, since: new Date().toISOString() }
    await $.fs.write(`${dir}/waiting/${id}.json`, JSON.stringify(body))
    void poll($)
  } catch {
    // flags are best-effort; never break a tool call or a turn
  }
}

async function readFlags($: EngineInterface): Promise<Map<string, Waiting>> {
  const out = new Map<string, Waiting>()
  const dir = await baseDir($)
  if (!dir) return out
  let entries: { name: string; mtimeMs: number }[] = []
  try {
    entries = await $.fs.list(`${dir}/waiting`)
  } catch {
    return out
  }
  const now = Date.now()
  for (const en of entries) {
    if (!en.name.endsWith('.json') || (en.mtimeMs && now - en.mtimeMs > FLAG_MAX_AGE_MS)) continue
    try {
      const r = await $.fs.read(`${dir}/waiting/${en.name}`)
      const o = parseJson<Obj>(typeof r === 'string' ? r : '')
      if (!o || o.cleared || typeof o.sessionId !== 'string') continue
      const since = typeof o.since === 'string' ? o.since : ''
      const t = Date.parse(since)
      if (Number.isNaN(t) || now - t > FLAG_MAX_AGE_MS) continue
      const reason: WaitReason = o.reason === 'permission' || o.reason === 'question' ? o.reason : 'turn'
      out.set(o.sessionId, { reason, since, question: typeof o.question === 'string' ? o.question : '' })
    } catch {
      // unreadable file: ignore
    }
  }
  return out
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// ---- poll ------------------------------------------------------------------------
async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  if (!(await isPlaced($))) return
  polling = true
  lastPollAt = Date.now()
  const checkedAt = new Date().toISOString()
  try {
    const rows = (await listSessions($)).map(r => toSess(r, false))
    const selfRaw = await callJson<Obj & Raw>($, 'get_session', { session_id: 'self' })
    if (selfRaw && typeof selfRaw.sessionId === 'string') {
      selfId = selfRaw.sessionId
      const have = rows.find(r => r.id === selfRaw.sessionId)
      if (have) have.isSelf = true
      else {
        const me = toSess(selfRaw, true)
        me.isRunning = true
        rows.push(me)
      }
    }
    const usageSelf = await callJson<UsageRes>($, 'get_usage', { session_id: 'self' })
    const flags = await readFlags($)
    const now = Date.now()
    const cutoff = now - RECENT_DAYS * 86400000
    const recent = rows.filter(s => s.isRunning || (Date.parse(s.lastActivityAt) || 0) >= cutoff)

    // details: working sessions every poll, idle ones cached ~2 min
    const need = recent.filter(s => {
      if (s.isSelf && selfRaw) return false
      const c = detailCache.get(s.id)
      return s.isRunning || !c || now - c.at > IDLE_CACHE_MS
    })
    for (let i = 0; i < need.length; i += 5) {
      await Promise.all(
        need.slice(i, i + 5).map(async s => {
          const o = await callJson<Obj>($, 'get_session', { session_id: s.id })
          if (o) detailCache.set(s.id, { at: Date.now(), d: detailOf(o) })
        }),
      )
    }
    if (selfRaw) {
      const self = rows.find(r => r.isSelf)
      if (self) detailCache.set(self.id, { at: now, d: detailOf(selfRaw) })
    }
    const ctx = new Map<string, number>()
    const sp = ctxPercent(usageSelf)
    if (sp !== null && selfRaw && typeof selfRaw.sessionId === 'string') ctx.set(selfRaw.sessionId, sp)
    const working = recent.filter(s => s.isRunning && !s.isSelf)
    for (let i = 0; i < working.length; i += 5) {
      await Promise.all(
        working.slice(i, i + 5).map(async s => {
          const c = ctxPercent(await callJson<UsageRes>($, 'get_usage', { session_id: s.id }))
          if (c !== null) ctx.set(s.id, c)
        }),
      )
    }
    const prev = await read($, snap)
    if (runStart.size === 0) for (const s of prev.sessions) if (s.workingSince) runStart.set(s.id, s.workingSince)
    for (const s of rows) {
      const d = detailCache.get(s.id)?.d
      if (d) {
        s.model = d.model
        s.effort = d.effort
        s.branch = d.branch
        s.perm = d.perm
      }
      const c = ctx.get(s.id)
      s.ctx = s.isRunning && c !== undefined ? c : null
      if (s.isRunning) {
        if (!runStart.has(s.id)) runStart.set(s.id, now)
        s.workingSince = runStart.get(s.id) ?? now
      } else runStart.delete(s.id)
      s.waiting = flags.get(s.id) ?? null
    }

    // working -> idle transitions: cheer, and one toast per transition
    let finished = 0
    let finishedTitle = ''
    for (const s of rows) {
      const was = prevRunning.get(s.id)
      if (was === true && !s.isRunning) {
        finished++
        finishedTitle = s.title
        if (!s.isSelf) void toastOnce($, s)
      }
      prevRunning.set(s.id, s.isRunning)
    }
    const cheerUntil = finished > 0 ? now + CHEER_MS : prev.cheerUntil
    const next: Snapshot = { checkedAt, sessions: rows, error: null, usage: planUsage(usageSelf), cheerUntil, cheerTitle: finished > 0 ? finishedTitle : prev.cheerTitle }
    // Redraw only when something changed (or about once a minute for the clock texts):
    // fewer redraws, and less chance of disturbing the person's scrolling.
    const same = (x: Snapshot) => JSON.stringify([x.sessions, x.error, x.usage, x.cheerUntil, x.cheerTitle])
    const fresh = prev.checkedAt !== '' && now - Date.parse(prev.checkedAt) < 50000
    if (!(fresh && same(prev) === same(next))) await update($, snap, () => next)
  } catch (err) {
    await update($, snap, s => (s.error === String(err).slice(0, 300) ? s : { ...s, checkedAt, error: String(err).slice(0, 300) }))
  } finally {
    polling = false
  }
}

// Several sessions may each have a placed pane: a marker file lets only one toast.
async function toastOnce($: EngineInterface, s: Sess): Promise<void> {
  try {
    const dir = await baseDir($)
    if (dir) {
      const path = `${dir}/toasted/${s.id}.json`
      const key = s.lastActivityAt
      if (await $.fs.exists(path)) {
        const o = parseJson<Obj>(String(await $.fs.read(path)))
        if (o && o.key === key) return
      }
      await $.fs.write(path, JSON.stringify({ key, at: new Date().toISOString() }))
    }
    $.ui.toast(`Clawd says ${clip(s.title, 60)} is done`)
  } catch {
    // no toast beats a duplicate or a crash
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (Date.now() - lastPollAt < POLL_MS - 500) return
  await poll($)
}

async function openSession($: EngineInterface, s: Sess): Promise<void> {
  if (!s.link || !s.link.startsWith('claude://')) return
  try {
    const r = await $.process.run(['/usr/bin/open', s.link])
    if (r.exitCode !== 0) $.ui.toast(`Couldn't open "${s.title}"`)
  } catch (err) {
    $.ui.toast(`Couldn't open "${s.title}": ${String(err).slice(0, 120)}`)
  }
}

function ago(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const m = Math.max(0, Math.round((now - t) / 60000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function folderName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? '(no folder)'
}

function areaName(cwd: string): string {
  const i = cwd.indexOf('/Local Work/')
  if (i < 0) return ''
  const rest = cwd.slice(i + '/Local Work/'.length).split('/')
  return rest.length > 1 ? (rest[0] ?? '') : ''
}

type Group = { key: string; name: string; area: string; latest: number; items: { s: Sess; depth: number }[] }

function buildGroups(all: Sess[]): Group[] {
  const time = (s: Sess) => Date.parse(s.lastActivityAt) || 0
  const byRecent = (a: Sess, b: Sess) => time(b) - time(a)
  const byId = new Map(all.map(s => [s.id, s]))
  const kids = new Map<string, Sess[]>()
  const roots: Sess[] = []
  for (const s of all) {
    const parent = s.startedBy ? byId.get(s.startedBy) : undefined
    if (parent && parent.cwd === s.cwd) {
      const list = kids.get(parent.id) ?? []
      list.push(s)
      kids.set(parent.id, list)
    } else roots.push(s)
  }
  const groups = new Map<string, Group>()
  const walk = (s: Sess, depth: number, g: Group, seen: Set<string>) => {
    if (seen.has(s.id)) return
    seen.add(s.id)
    g.items.push({ s, depth })
    g.latest = Math.max(g.latest, time(s))
    for (const k of (kids.get(s.id) ?? []).sort(byRecent)) walk(k, depth + 1, g, seen)
  }
  const seen = new Set<string>()
  for (const r of roots.sort(byRecent)) {
    const scratch = /^scratch-\d{4}-\d{2}-\d{2}/.test(folderName(r.cwd))
    const key = scratch ? 'scratch' : r.cwd
    let g = groups.get(key)
    if (!g) {
      g = scratch
        ? { key, name: 'Scratch sessions', area: 'no project folder', latest: 0, items: [] }
        : { key, name: folderName(r.cwd), area: areaName(r.cwd), latest: 0, items: [] }
      groups.set(key, g)
    }
    walk(r, 0, g, seen)
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest)
}

const GREEN = '#1D9E75'
const GREEN_LIGHT = '#9FE1CB'
const AMBER = '#EF9F27'
const RED = '#E24B4A'
const GREY = '#888780'
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
const DOT_IDLE = svg(10, 10, `<circle cx="5" cy="5" r="3.75" fill="none" stroke="${GREY}" stroke-width="1.5"/>`)
const FOLDER = svg(14, 14, `<path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="${GREY}" stroke-width="1.2" stroke-linejoin="round"/>`)
const CORNER = svg(12, 12, `<path d="M3 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5H10M7.5 6l2.5 2.5L7.5 11" fill="none" stroke="${GREY}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`)
const PHONE = svg(12, 12, `<rect x="3" y="1" width="6" height="10" rx="1.3" fill="none" stroke="${GREY}" stroke-width="1.1"/><path d="M5.3 9.2h1.4" stroke="${GREY}" stroke-width="1.1" stroke-linecap="round"/>`)
const ROW_HOVER = 'rgba(128,128,128,0.12)'
const GROUP_BG = 'rgba(128,128,128,0.07)'
const GROUP_HEAD_BG = 'rgba(128,128,128,0.10)'
// Box widths are in character cells, not pixels (Svg width/height are pixels).
const TIME_W = 7
const RC_W = 7
const MODEL_STYLE: Record<string, { bg: string; fg: string }> = {
  opus: { bg: 'rgba(216,90,48,0.16)', fg: '#993C1D' },
  sonnet: { bg: 'rgba(55,138,221,0.16)', fg: '#185FA5' },
  fable: { bg: 'rgba(127,119,221,0.18)', fg: '#534AB7' },
  haiku: { bg: 'rgba(29,158,117,0.16)', fg: '#0F6E56' },
}
const MODEL_OTHER = { bg: 'rgba(128,128,128,0.16)', fg: '#5F5E5A' }
const modelStyle = (id: string) => MODEL_STYLE[/^claude-([a-z]+)/.exec(id)?.[1] ?? ''] ?? MODEL_OTHER
const PERM_INK = '#5F5E5A'
const pst = (d: string, c = PERM_INK) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`
// Permission mode icons, 12x12.
const PERM_ICON: Record<string, { svg: string; label: string; glyph: string }> = {
  auto: { svg: svg(12, 12, pst('M7 1 3 6.8h2.6L5 11l4-6H6.4z')), label: 'Auto mode', glyph: '⚡' },
  acceptEdits: { svg: svg(12, 12, pst('M2 10l.5-2.5L8.5 1.5l2 2-6 6zM7.3 2.7l2 2')), label: 'Accept edits', glyph: '✎' },
  plan: { svg: svg(12, 12, pst('M2.5 2h7v8h-7zM4.3 4.5h3.4M4.3 6.5h3.4M4.3 8.3h2')), label: 'Plan mode', glyph: '☰' },
  default: { svg: svg(12, 12, pst('M6 1 2 2.6V6c0 2.3 1.7 4 4 5 2.3-1 4-2.7 4-5V2.6z')), label: 'Asks before acting', glyph: '◇' },
  bypassPermissions: { svg: svg(12, 12, pst('M6 1.2 11 10H1zM6 4.5v2.6M6 8.6v.1', '#C9561E')), label: 'Bypass permissions', glyph: '⚠' },
}
const PERM_WORD: Record<string, string> = { auto: 'auto', acceptEdits: 'accept edits', plan: 'plan', default: 'asks first', bypassPermissions: 'bypass' }
const ctxColor = (p: number) => (p > 85 ? RED : p >= 65 ? AMBER : GREEN)
const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}
const SELF_BG = 'rgba(55,138,221,0.14)'
const CHIP_GREEN = 'rgba(29,158,117,0.14)'
const CHIP_GREY = 'rgba(128,128,128,0.12)'
const CHIP_AMBER = 'rgba(239,159,39,0.2)'
const NEED_BG = 'rgba(239,159,39,0.1)'

const LEGEND_PERMS = ['auto', 'acceptEdits', 'plan', 'default', 'bypassPermissions']
const REASON: Record<WaitReason, string> = { permission: 'permission', question: 'question', turn: 'your turn' }

function waitingFor(w: Waiting, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(w.since)) / 60000))
  return m < 1 ? 'waiting now' : m < 60 ? `waiting ${m}m` : `waiting ${Math.round(m / 60)}h`
}

function lastLine(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

function toolBrief(tool: string, input: unknown): string {
  const i = isObj(input) ? input : {}
  const v = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern
  return typeof v === 'string' ? `${tool}: ${clip(v, 100)}` : tool
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sessions', description: 'Open the Sessions pane' })
    void $.ui.open({ id: PANE, title: 'Sessions' })
    void getSelfId($)
    void (async () => {
      const saved = await $.store.get('perGroup').catch(() => undefined)
      if (typeof saved === 'number') await update($, view, v => ({ ...v, perGroup: saved }))
    })()
    ticker?.cancel()
    // A cheap local check (is the pane drawn?); the session list is read only while it is.
    ticker = $.clock.every(CHECK_MS, () => tick($))
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    void tick($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = null
    await writeFlag($, null)
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sessions' })
    await poll($)
    return { text: 'Sessions pane opened.' }
  })

  // ---- needs-you detection (runs in every session, placed or not) ----------------
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // A real call (tool_use_id) the engine will put to a person: a permission prompt is up.
    if (e.tool_use_id && verdict.decision === 'ask' && e.approver === 'person' && e.tool !== 'AskUserQuestion') {
      // In auto or bypass mode the app decides by itself: no prompt reaches me.
      const mode = await getSelfMode($).catch(() => '')
      if (mode !== 'auto' && mode !== 'bypassPermissions') {
        const id = e.tool_use_id
        const brief = toolBrief(e.tool, e.input)
        activeWaits.add(id)
        // Only flag a prompt that is still open after a moment (quick approvals never flash amber).
        $.clock.after(2000, () => {
          if (activeWaits.has(id)) void writeFlag($, { reason: 'permission', question: brief, since: new Date().toISOString() })
        })
      }
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const args = e as unknown as Obj
    if (e.tool === 'AskUserQuestion') {
      const qs = Array.isArray(args.questions) ? args.questions : []
      const first = isObj(qs[0]) ? qs[0] : {}
      activeWaits.add(id)
      void writeFlag($, { reason: 'question', question: clip(typeof first.question === 'string' ? first.question : 'Claude asked a question', 160), since: new Date().toISOString() })
    } else if (!e.agentId && e.tool.endsWith('wrap_up') && typeof args.ask === 'string' && args.ask) {
      wrapAsk = args.ask
    }
    try {
      return await next(e)
    } finally {
      if (activeWaits.delete(id) && activeWaits.size === 0) void writeFlag($, null)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.reason === 'answer') {
      const ask = wrapAsk
      wrapAsk = ''
      const last = lastLine(e.answer).replace(/[*_`)\]]+$/, '')
      activeWaits.clear()
      if (ask || last.endsWith('?')) {
        void writeFlag($, { reason: 'turn', question: clip(ask || last, 160), since: new Date().toISOString() })
      } else {
        // the turn ended without a question: nothing is waiting on me
        void writeFlag($, null)
      }
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    wrapAsk = ''
    void writeFlag($, null)
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data
    if (e.requestId === PANE && e.element.startsWith('shim:') && isObj(data) && typeof data.open === 'string') {
      const p = await read($, snap)
      const s = p.sessions.find(x => x.id === data.open)
      if (s) await openSession($, s)
      return {}
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const Client = 'Client' in els ? els.Client : null
    const icon = (source: string, alt: string, size: number, glyph: string, color?: string) =>
      Svg
        ? <Box flexShrink={0}><Svg source={source} alt={alt} width={size} height={size} /></Box>
        : <Text color={color} dimColor={!color}>{glyph}</Text>
    const p = await read($, snap)
    const v = await read($, view)
    const now = Date.now()
    const cutoff = now - RECENT_DAYS * 86400000
    void cutoff
    const recent = p.sessions
      // a session that is working again is not waiting on me, unless it is stuck on a permission prompt
      .map(s => (s.waiting && s.isRunning && s.waiting.reason !== 'permission' ? { ...s, waiting: null } : s))
    const hidden = 0
    const staleBefore = now - STALE_DAYS * 86400000
    const isStale = (g: { latest: number }) => g.latest < staleBefore
    const allGroups = buildGroups(recent)
    const groups = [...allGroups.filter(g => !isStale(g)), ...allGroups.filter(isStale)]
    const firstStale = groups.find(isStale)?.key ?? null
    const working = recent.filter(s => s.isRunning).length
    const needing = recent.filter(s => s.waiting).sort((a, b) => Date.parse(a.waiting?.since ?? '') - Date.parse(b.waiting?.since ?? ''))
    const chip = (key: string, bg: string, color: string | undefined, text: string) => (
      <Box key={key} backgroundColor={bg} paddingX={1} flexShrink={0}>
        <Text size="caption" color={color} dimColor={!color} wrap="truncate-end">{text}</Text>
      </Box>
    )

    const mini = (m: Mood) => icon(clawd(m, 16, 12), 'Clawd, working', 16, '●', 'success')

    // At most SHIMMER_MAX rows shimmer; the rest get still green text.
    let shimmering = 0
    const title = (s: Sess, k: string) => {
      const label = clip(s.isSelf ? `${s.title} (this one)` : s.title, 48)
      if (s.isRunning && Client) {
        const wave = shimmering < SHIMMER_MAX
        shimmering++
        return (
          <Client
            key={`shim:${k}:${s.id}`}
            module="./shimmer.tsx"
            props={{ id: s.id, text: label, bright: GREEN_LIGHT, dim: GREEN, clickable: !!s.link, still: !wave } satisfies ShimmerProps}
          />
        )
      }
      if (s.link) {
        return (
          <Button key={`open:${k}:${s.id}`} plain label={label} onPress={() => void openSession($, s)} />
        )
      }
      return <Text wrap="truncate-end" color={s.isRunning ? GREEN : undefined}>{label}</Text>
    }

    const statusIcon = (s: Sess) =>
      s.waiting ? (Svg ? <Svg source={pulseDot(AMBER)} alt="needs you" width={10} height={10} /> : <Text color="warning">●</Text>)
      : s.isRunning ? mini('busy')
      : icon(DOT_IDLE, 'idle', 10, '○')

    // helpers: descendants of each parent, counted from the groups' depth-first order
    const helpers = new Map<string, { n: number; w: number }>()
    for (const g of groups) {
      g.items.forEach(({ s, depth }, i) => {
        let n = 0
        let w = 0
        for (let j = i + 1; j < g.items.length; j++) {
          const it = g.items[j]
          if (!it || it.depth <= depth) break
          n++
          if (it.s.isRunning) w++
        }
        if (n > 0) helpers.set(s.id, { n, w })
      })
    }

    const permIcon = (perm: string) => {
      const pi = PERM_ICON[perm]
      if (!pi) return <Text size="caption" dimColor>{perm}</Text>
      return icon(pi.svg, pi.label, 12, pi.glyph)
    }

    const row = (s: Sess, depth: number, key: string, pinned: boolean) => {
      const ms = s.model ? modelStyle(s.model) : null
      const kids = helpers.get(s.id)
      const small = (k: string, text: string, color?: string) => (
        <Text key={`${k}:${key}`} size="caption" dimColor={!color} color={color}>{text}</Text>
      )
      const bits = [
        s.effort ? small('e', s.effort) : null,
        s.isRunning && s.workingSince ? small('w', `working ${dur(now - s.workingSince)}`, GREEN) : null,
        kids ? small('h', `${kids.n} helper${kids.n === 1 ? '' : 's'}${kids.w > 0 ? ` · ${kids.w} working` : ''}`) : null,
        s.branch ? small('b', s.branch) : null,
      ].filter(Boolean)
      const hasDetail = !!ms || !!s.perm || s.ctx !== null || bits.length > 0
      return (
      <Box
        key={key}
        flexDirection="column"
        paddingLeft={1 + depth * 2}
        paddingRight={1}
        backgroundColor={pinned ? NEED_BG : s.isSelf ? SELF_BG : undefined}
        hover={{ backgroundColor: ROW_HOVER }}
      >
        <Box flexDirection="row" gap={1} alignItems="center" width="100%">
          {depth > 0 && icon(CORNER, 'started by the session above', 12, '↳')}
          {statusIcon(s)}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>{title(s, pinned ? 'n' : 's')}</Box>
          {pinned && s.waiting && chip(`r:${key}`, CHIP_AMBER, 'warning', REASON[s.waiting.reason])}
          <Box width={RC_W} flexShrink={0} justifyContent="center">{s.remote ? icon(PHONE, 'Remote Control on', 12, 'RC') : null}</Box>
          <Box width={pinned && s.waiting ? TIME_W + 6 : TIME_W} flexShrink={0} justifyContent="flex-end">
            <Text dimColor size="caption" tabular>
              {pinned && s.waiting ? waitingFor(s.waiting, now) : ago(s.lastActivityAt, now)}
            </Text>
          </Box>
        </Box>
        {pinned && s.waiting?.question ? (
          <Box paddingLeft={3}><Text size="caption" color="warning" wrap="truncate-end">{s.waiting.question}</Text></Box>
        ) : null}
        {hasDetail ? (
          <Box paddingLeft={3} flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            {ms ? chip(`m:${key}`, ms.bg, ms.fg, shortModel(s.model)) : null}
            {s.perm ? (
              <Box key={`p:${key}`} flexDirection="row" gap={1} alignItems="center">
                {permIcon(s.perm)}
                <Text size="caption" dimColor>{PERM_WORD[s.perm] ?? s.perm}</Text>
              </Box>
            ) : null}
            {s.ctx !== null ? (
              <Box key={`x:${key}`} flexDirection="row" gap={1} alignItems="center">
                {Svg ? <Svg source={usageBar(s.ctx, 40, ctxColor(s.ctx))} alt={`${s.ctx} percent of context used`} width={40} height={6} /> : null}
                <Text size="caption" dimColor tabular>{Svg ? `${s.ctx}%` : `ctx ${s.ctx}%`}</Text>
              </Box>
            ) : null}
            {bits}
          </Box>
        ) : null}
      </Box>
      )
    }

    const five = p.usage.find(x => x.label.toLowerCase().startsWith('5-hour')) ?? null
    const longest = needing[0]?.waiting ?? null

    const stageIn = {
      now,
      working: recent.filter(s => s.isRunning).map(s => s.title),
      waiting: needing.length,
      cheerTitle: p.cheerUntil > now ? p.cheerTitle || 'A session' : null,
      hot: p.usage.some(x => x.percent > 80),
    }

    return (
      <Box flexDirection="column" gap={1}>
        {Svg
          ? <Svg key="stage" source={stageSvg(stageIn)} alt={stageText(stageIn)} />
          : <Text key="stage" dimColor>{stageText(stageIn)}</Text>}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1} alignItems="center">
            {needing.length > 0 && chip('c:need', CHIP_AMBER, 'warning', `${needing.length} need you`)}
            {chip('c:work', CHIP_GREEN, 'success', `${working} working`)}
            {chip('c:idle', CHIP_GREY, undefined, `${recent.length - working} idle`)}
          </Box>
          <Button key="refresh" label="Refresh" plain dimColor onPress={() => void poll($)} />
        </Box>
        {longest && (
          <Text size="caption" color="warning">{`longest waiting: ${dur(now - Date.parse(longest.since))}`}</Text>
        )}
        {p.usage.length > 0 && (
          <Box flexDirection="column" gap={1} backgroundColor={GROUP_BG} paddingX={1} paddingY={1}>
            {[...p.usage].sort((a, b) => Number(b.label.toLowerCase().startsWith('5-hour')) - Number(a.label.toLowerCase().startsWith('5-hour'))).map((w, i) => {
              const c = w.percent > 80 ? RED : w.percent >= 60 ? AMBER : GREEN
              return (
                <Box key={`u:${i}`} flexDirection="row" gap={1} alignItems="center" width="100%">
                  <Box width={20} flexShrink={0}><Text size="caption" dimColor wrap="truncate-end">{w.label}</Text></Box>
                  <Box flexShrink={0}>
                    {Svg
                      ? <Svg source={usageBar(w.percent, 140, c)} alt={`${w.percent} percent of ${w.label} used`} width={140} height={6} />
                      : <Text size="caption" color={c}>{'█'.repeat(Math.round(w.percent / 10)) + '░'.repeat(10 - Math.round(w.percent / 10))}</Text>}
                  </Box>
                  <Box width={5} flexShrink={0} justifyContent="flex-end"><Text size="caption" weight="medium" tabular>{`${w.percent}%`}</Text></Box>
                  <Box flexGrow={1} flexShrink={1}><Text size="caption" dimColor tabular wrap="truncate-end">{w.resetsIn ? `resets in ${w.resetsIn}` : ''}</Text></Box>
                </Box>
              )
            })}
          </Box>
        )}
        {p.error !== null && <Text color="error">{`Couldn't read sessions: ${p.error}`}</Text>}
        {p.checkedAt === '' && <Text dimColor>Loading sessions…</Text>}
        {p.checkedAt !== '' && recent.length === 0 && p.error === null && (
          <Box flexDirection="column" alignItems="center" gap={1}>
            {Svg ? <Svg source={clawd('asleep', 64, 48)} alt="Clawd asleep" width={64} height={48} /> : null}
            <Text dimColor>All quiet</Text>
          </Box>
        )}
        {needing.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center">
              {Svg ? <Svg source={pulseDot(AMBER)} alt="needs you section" width={10} height={10} /> : <Text color="warning">●</Text>}
              <Text size="footnote" weight="medium" color="warning">Needs you</Text>
            </Box>
            {needing.map(s => row(s, 0, `n:${s.id}`, true))}
          </Box>
        )}
        {groups.length > 0 && (
          <Box flexDirection="row" gap={1} alignItems="center" paddingX={1} width="100%">
            <Box flexGrow={1} flexShrink={1}><Text size="caption" dimColor>Environment · session</Text></Box>
            <Box width={RC_W} flexShrink={0} justifyContent="center"><Text size="caption" dimColor>Remote</Text></Box>
            <Box width={TIME_W} flexShrink={0} justifyContent="flex-end"><Text size="caption" dimColor>Active</Text></Box>
          </Box>
        )}
        {groups.map(g => {
          const stale = isStale(g)
          // fresh projects start open, stale ones start folded; the arrow flips either
          const isCollapsed = stale ? !v.collapsed.includes(g.key) : v.collapsed.includes(g.key)
          const isExpanded = v.expanded.includes(g.key)
          const limit = v.perGroup > 0 && !isExpanded ? v.perGroup : Infinity
          // working and waiting sessions always show; the rest fill up to the limit
          let room = limit
          const shown = g.items.filter(({ s }) => {
            if (s.isRunning || s.waiting || s.isSelf) return true
            if (room > 0) { room--; return true }
            return false
          })
          const extra = g.items.length - shown.length
          const busy = g.items.filter(({ s }) => s.isRunning).length
          const need = g.items.filter(({ s }) => s.waiting).length
          return (
            <Box key={`gw:${g.key}`} flexDirection="column" gap={1}>
            {g.key === firstStale && (
              <Box paddingTop={1}><Text size="caption" dimColor>{`Older projects (no activity for ${STALE_DAYS}+ days)`}</Text></Box>
            )}
            <Box key={`g:${g.key}`} flexDirection="column" backgroundColor={GROUP_BG} paddingBottom={isCollapsed ? 0 : 1}>
              <Box flexDirection="row" gap={1} alignItems="center" backgroundColor={GROUP_HEAD_BG} paddingX={1} paddingY={1}>
                <Button
                  key={`fold:${g.key}`}
                  plain
                  label={isCollapsed ? '▸' : '▾'}
                  onPress={() => void update($, view, x => ({ ...x, collapsed: toggle(x.collapsed, g.key) }))}
                />
                {icon(FOLDER, `folder ${g.name}`, 14, '')}
                <Box flexGrow={1} flexShrink={1} flexDirection="row" gap={1} alignItems="center">
                  <Text weight="semibold" wrap="truncate-end">{g.name}</Text>
                  {g.area ? <Text size="caption" dimColor wrap="truncate-end">{g.area}</Text> : null}
                </Box>
                {need > 0 && chip(`gn:${g.key}`, CHIP_AMBER, 'warning', `${need} need you`)}
                {busy > 0 && chip(`gw:${g.key}`, CHIP_GREEN, 'success', `${busy} working`)}
                <Box width={RC_W} flexShrink={0} />
                <Box width={TIME_W} flexShrink={0} justifyContent="flex-end">
                  <Text size="caption" dimColor tabular>{String(g.items.length)}</Text>
                </Box>
              </Box>
              {!isCollapsed && shown.map(({ s, depth }) => row(s, depth, `s:${s.id}`, false))}
              {!isCollapsed && (extra > 0 || isExpanded) && (
                <Box paddingLeft={3}>
                  <Button
                    key={`more:${g.key}`}
                    plain
                    dimColor
                    label={isExpanded ? 'Show less' : `Show ${extra} more`}
                    onPress={() => void update($, view, x => ({ ...x, expanded: toggle(x.expanded, g.key) }))}
                  />
                </Box>
              )}
            </Box>
            </Box>
          )
        })}
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text size="caption" dimColor>Show per project:</Text>
          {PER_GROUP_CHOICES.map(n => {
            const label = n === 0 ? 'All' : String(n)
            return v.perGroup === n
              ? <Text key={`pg:${n}`} size="caption" weight="semibold">{`[${label}]`}</Text>
              : (
                <Button
                  key={`pg:${n}`}
                  plain
                  dimColor
                  label={label}
                  onPress={() => {
                    void update($, view, x => ({ ...x, perGroup: n, expanded: [] }))
                    void $.store.set('perGroup', n)
                  }}
                />
              )
          })}
        </Box>
        <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
          <Box flexDirection="row" gap={1} alignItems="center">{mini('busy')}<Text size="caption" dimColor>Working</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{icon(DOT_IDLE, 'key: idle', 10, '○')}<Text size="caption" dimColor>Idle</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{Svg ? <Svg source={pulseDot(AMBER)} alt="key: needs you" width={10} height={10} /> : <Text color="warning">●</Text>}<Text size="caption" dimColor>Needs you</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{icon(PHONE, 'key: remote', 12, 'RC')}<Text size="caption" dimColor>Remote</Text></Box>
          {LEGEND_PERMS.map(k => {
            const pi = PERM_ICON[k]
            return pi ? (
              <Box key={`lp:${k}`} flexDirection="row" gap={1} alignItems="center">{icon(pi.svg, `key: ${pi.label}`, 12, pi.glyph)}<Text size="caption" dimColor>{pi.label}</Text></Box>
            ) : null
          })}
          <Text size="caption" dimColor>
            {`${hidden > 0 ? `${hidden} older hidden · ` : ''}updated ${p.checkedAt ? ago(p.checkedAt, now) : '—'}`}
          </Text>
        </Box>
      </Box>
    )
  })
}
