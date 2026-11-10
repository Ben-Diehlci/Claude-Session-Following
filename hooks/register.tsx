import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, Timer } from 'claude-code'

import type { Sess, Snapshot, Usage, Waiting, WaitReason } from '../types'
import { clawd, pulseDot, usageBar, type Mood } from './clawd'
import type { ShimmerProps } from './shimmer'

const PANE = 'session-following'
const SERVER = 'ccd_session_mgmt'
const RECENT_DAYS = 3
const POLL_MS = 10000
const CHECK_MS = 4000
const IDLE_CACHE_MS = 120000
const SHIMMER_MAX = 4
const CHEER_MS = 10000
const FLAG_MAX_AGE_MS = 24 * 3600 * 1000
const EMPTY: Snapshot = { checkedAt: '', sessions: [], error: null, usage: null, cheerUntil: 0 }
// Bump the tag when Snapshot changes: it declines what an earlier version stored.
const snap = atom({ plugin: 'session-following', key: 'snap' } as const, EMPTY, {
  shape: 'snap-2',
})

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
const detailCache = new Map<string, { at: number; parts: string[] }>()
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
    detail: '',
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

function detailParts(o: Obj): string[] {
  const parts: string[] = []
  if (typeof o.model === 'string' && o.model) parts.push(shortModel(o.model))
  if (typeof o.effort === 'string' && o.effort) parts.push(o.effort)
  if (typeof o.permissionMode === 'string' && o.permissionMode) parts.push(o.permissionMode)
  return parts
}

type UsageRes = {
  plan?: { status?: string; windows?: { label?: string; percentUsed?: number; resetsIn?: string }[] }
  context?: { status?: string; percentUsed?: number }
}

function planUsage(u: UsageRes | null): Usage | null {
  if (!u || !u.plan || u.plan.status !== 'ok' || !Array.isArray(u.plan.windows)) return null
  const w = u.plan.windows.find(x => typeof x.label === 'string' && x.label.toLowerCase().startsWith('5-hour'))
  if (!w || typeof w.percentUsed !== 'number') return null
  return { percent: Math.round(w.percentUsed), resetsIn: typeof w.resetsIn === 'string' ? w.resetsIn : '' }
}

function ctxPercent(u: UsageRes | null): number | null {
  return u && u.context && u.context.status === 'ok' && typeof u.context.percentUsed === 'number' ? Math.round(u.context.percentUsed) : null
}

// ---- needs-you flags: one small JSON file per session ----------------------------
async function baseDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return home ? `${home}/.claude/session-following` : ''
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
          if (o) detailCache.set(s.id, { at: Date.now(), parts: [...detailParts(o), branchOf(o)].filter(Boolean) })
        }),
      )
    }
    if (selfRaw) {
      const self = rows.find(r => r.isSelf)
      if (self) detailCache.set(self.id, { at: now, parts: [...detailParts(selfRaw), branchOf(selfRaw)].filter(Boolean) })
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
    for (const s of rows) {
      const parts = [...(detailCache.get(s.id)?.parts ?? [])]
      const c = ctx.get(s.id)
      if (s.isRunning && c !== undefined) parts.splice(Math.min(3, parts.length), 0, `context ${c}%`)
      s.detail = parts.join(' · ')
      s.waiting = flags.get(s.id) ?? null
    }

    // working -> idle transitions: cheer, and one toast per transition
    let finished = 0
    for (const s of rows) {
      const was = prevRunning.get(s.id)
      if (was === true && !s.isRunning) {
        finished++
        if (!s.isSelf) void toastOnce($, s)
      }
      prevRunning.set(s.id, s.isRunning)
    }
    const prev = await read($, snap)
    const cheerUntil = finished > 0 ? now + CHEER_MS : prev.cheerUntil
    await update($, snap, () => ({ checkedAt, sessions: rows, error: null, usage: planUsage(usageSelf), cheerUntil }))
  } catch (err) {
    await update($, snap, s => ({ ...s, checkedAt, error: String(err).slice(0, 300) }))
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
    const key = r.cwd
    let g = groups.get(key)
    if (!g) {
      g = { key, name: folderName(r.cwd), area: areaName(r.cwd), latest: 0, items: [] }
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
const SELF_BG = 'rgba(55,138,221,0.14)'
const CHIP_GREEN = 'rgba(29,158,117,0.14)'
const CHIP_GREY = 'rgba(128,128,128,0.12)'
const CHIP_AMBER = 'rgba(239,159,39,0.2)'
const NEED_BG = 'rgba(239,159,39,0.1)'

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
      activeWaits.add(e.tool_use_id)
      void writeFlag($, { reason: 'permission', question: toolBrief(e.tool, e.input), since: new Date().toISOString() })
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
      if (ask || last.endsWith('?')) {
        void writeFlag($, { reason: 'turn', question: clip(ask || last, 160), since: new Date().toISOString() })
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
      Svg ? <Svg source={source} alt={alt} width={size} height={size} /> : <Text color={color} dimColor={!color}>{glyph}</Text>
    const p = await read($, snap)
    const now = Date.now()
    const cutoff = now - RECENT_DAYS * 86400000
    const recent = p.sessions.filter(s => s.isRunning || (Date.parse(s.lastActivityAt) || 0) >= cutoff)
    const hidden = p.sessions.length - recent.length
    const groups = buildGroups(recent)
    const working = recent.filter(s => s.isRunning).length
    const needing = recent.filter(s => s.waiting).sort((a, b) => Date.parse(a.waiting?.since ?? '') - Date.parse(b.waiting?.since ?? ''))
    const chip = (key: string, bg: string, color: string | undefined, text: string) => (
      <Box key={key} backgroundColor={bg} paddingX={1}>
        <Text size="caption" color={color} dimColor={!color}>{text}</Text>
      </Box>
    )

    const mood: Mood =
      needing.length > 0 ? 'waving'
      : p.error !== null || (p.usage?.percent ?? 0) > 80 ? 'worried'
      : p.cheerUntil > now ? 'cheering'
      : working > 0 ? 'busy'
      : 'asleep'
    const mini = (m: Mood) => icon(clawd(m, 16, 12), 'Clawd, working', 16, '●', 'success')

    // At most SHIMMER_MAX rows shimmer; the rest get still green text.
    let shimmering = 0
    const title = (s: Sess) => {
      const label = clip(s.isSelf ? `${s.title} (this one)` : s.title, 48)
      if (s.isRunning && Client) {
        const wave = shimmering < SHIMMER_MAX
        shimmering++
        return (
          <Client
            key={`shim:${s.id}`}
            module="./shimmer.tsx"
            props={{ id: s.id, text: label, bright: GREEN_LIGHT, dim: GREEN, clickable: !!s.link, still: !wave } satisfies ShimmerProps}
          />
        )
      }
      if (s.link) {
        return (
          <Button key={`open:${s.id}`} plain label={label} dimColor={!s.isRunning && !s.isSelf} onPress={() => void openSession($, s)} />
        )
      }
      return <Text wrap="truncate-end" color={s.isRunning ? GREEN : undefined}>{label}</Text>
    }

    const statusIcon = (s: Sess) =>
      s.waiting ? (Svg ? <Svg source={pulseDot(AMBER)} alt="needs you" width={10} height={10} isInteractive /> : <Text color="warning">●</Text>)
      : s.isRunning ? mini('busy')
      : icon(DOT_IDLE, 'idle', 10, '○')

    const row = (s: Sess, depth: number, key: string, pinned: boolean) => (
      <Box
        key={key}
        flexDirection="column"
        paddingLeft={1 + depth * 2}
        paddingRight={1}
        backgroundColor={pinned ? NEED_BG : s.isSelf ? SELF_BG : undefined}
        hover={{ backgroundColor: ROW_HOVER }}
      >
        <Box flexDirection="row" gap={1} alignItems="center">
          {depth > 0 && icon(CORNER, 'started by the session above', 12, '↳')}
          {statusIcon(s)}
          <Box flexGrow={1} flexShrink={1}>{title(s)}</Box>
          {pinned && s.waiting && chip(`r:${s.id}`, CHIP_AMBER, 'warning', REASON[s.waiting.reason])}
          {s.remote && icon(PHONE, 'Remote Control on', 12, 'RC')}
          <Text dimColor size="caption" tabular>
            {pinned && s.waiting ? waitingFor(s.waiting, now) : ago(s.lastActivityAt, now)}
          </Text>
        </Box>
        {pinned && s.waiting?.question ? (
          <Box paddingLeft={3}><Text size="caption" color="warning" wrap="truncate-end">{s.waiting.question}</Text></Box>
        ) : null}
        {s.detail ? (
          <Box paddingLeft={3}><Text size="caption" dimColor wrap="truncate-end">{s.detail}</Text></Box>
        ) : null}
      </Box>
    )

    const pct = p.usage?.percent ?? 0
    const barColor = pct > 80 ? RED : pct >= 60 ? AMBER : GREEN

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg ? <Svg source={clawd(mood, 32, 24)} alt={`Clawd, ${mood}`} width={32} height={24} isInteractive /> : null}
            {needing.length > 0 && chip('c:need', CHIP_AMBER, 'warning', `${needing.length} need you`)}
            {chip('c:work', CHIP_GREEN, 'success', `${working} working`)}
            {chip('c:idle', CHIP_GREY, undefined, `${recent.length - working} idle`)}
          </Box>
          <Button key="refresh" label="Refresh" plain dimColor onPress={() => void poll($)} />
        </Box>
        {p.usage !== null && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text size="caption" dimColor>5-hour limit</Text>
            {Svg
              ? <Svg source={usageBar(pct, 90, barColor)} alt={`${pct} percent of the 5-hour limit used`} width={90} height={6} />
              : <Text size="caption" color={barColor}>{'█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))}</Text>}
            <Text size="caption" dimColor tabular>{`${pct}%${p.usage.resetsIn ? ` · resets in ${p.usage.resetsIn}` : ''}`}</Text>
          </Box>
        )}
        {p.error !== null && <Text color="error">{`Couldn't read sessions: ${p.error}`}</Text>}
        {p.checkedAt === '' && <Text dimColor>Loading sessions…</Text>}
        {p.checkedAt !== '' && recent.length === 0 && p.error === null && (
          <Box flexDirection="column" alignItems="center" gap={1}>
            {Svg ? <Svg source={clawd('asleep', 64, 48)} alt="Clawd asleep" width={64} height={48} isInteractive /> : null}
            <Text dimColor>All quiet</Text>
          </Box>
        )}
        {needing.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center">
              {Svg ? <Svg source={pulseDot(AMBER)} alt="" width={10} height={10} isInteractive /> : <Text color="warning">●</Text>}
              <Text size="footnote" weight="medium" color="warning">Needs you</Text>
            </Box>
            {needing.map(s => row(s, 0, `n:${s.id}`, true))}
          </Box>
        )}
        {groups.map(g => (
          <Box key={`g:${g.key}`} flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center" paddingBottom={0}>
              {icon(FOLDER, '', 14, '▸')}
              <Box flexGrow={1} flexShrink={1}>
                <Text size="footnote" weight="medium" dimColor wrap="truncate-end">
                  {g.area ? `${g.name}  ·  ${g.area}` : g.name}
                </Text>
              </Box>
              <Text size="caption" dimColor tabular>{String(g.items.length)}</Text>
            </Box>
            {g.items.map(({ s, depth }) => row(s, depth, `s:${s.id}`, false))}
          </Box>
        ))}
        <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
          <Box flexDirection="row" gap={1} alignItems="center">{mini('busy')}<Text size="caption" dimColor>Working</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{icon(DOT_IDLE, '', 10, '○')}<Text size="caption" dimColor>Idle</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{Svg ? <Svg source={pulseDot(AMBER)} alt="" width={10} height={10} /> : <Text color="warning">●</Text>}<Text size="caption" dimColor>Needs you</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{icon(PHONE, '', 12, 'RC')}<Text size="caption" dimColor>Remote</Text></Box>
          <Text size="caption" dimColor>
            {`${hidden > 0 ? `${hidden} older hidden · ` : ''}updated ${p.checkedAt ? ago(p.checkedAt, now) : '—'}`}
          </Text>
        </Box>
      </Box>
    )
  })
}
