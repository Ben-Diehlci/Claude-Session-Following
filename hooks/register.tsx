import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Sess, Snapshot } from '../types'

const PANE = 'session-following'
const SERVER = 'ccd_session_mgmt'
const RECENT_DAYS = 3
const EMPTY: Snapshot = { checkedAt: '', sessions: [], error: null }
const snap = atom({ plugin: 'session-following', key: 'snap' } as const, EMPTY, {
  shape: 'snap-1',
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
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
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

async function poll($: EngineInterface): Promise<void> {
  const checkedAt = new Date().toISOString()
  try {
    const rows = (await listSessions($)).map(r => toSess(r, false))
    try {
      const selfRes = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
      const raw = selfRes.isError ? null : parseJson<Raw>(textOf(selfRes))
      if (raw && raw.sessionId && !rows.some(r => r.id === raw.sessionId)) {
        const me = toSess(raw, true)
        me.isRunning = true
        rows.push(me)
      }
    } catch {
      // this session is optional; the list still shows
    }
    await update($, snap, () => ({ checkedAt, sessions: rows, error: null }))
  } catch (err) {
    await update($, snap, s => ({ ...s, checkedAt, error: String(err).slice(0, 300) }))
  }
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
const GREY = '#888780'
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
const DOT_RUN = svg(10, 10, `<circle cx="5" cy="5" r="4.5" fill="${GREEN}"/>`)
const DOT_IDLE = svg(10, 10, `<circle cx="5" cy="5" r="3.75" fill="none" stroke="${GREY}" stroke-width="1.5"/>`)
const FOLDER = svg(14, 14, `<path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="${GREY}" stroke-width="1.2" stroke-linejoin="round"/>`)
const CORNER = svg(12, 12, `<path d="M3 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5H10M7.5 6l2.5 2.5L7.5 11" fill="none" stroke="${GREY}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`)
const PHONE = svg(12, 12, `<rect x="3" y="1" width="6" height="10" rx="1.3" fill="none" stroke="${GREY}" stroke-width="1.1"/><path d="M5.3 9.2h1.4" stroke="${GREY}" stroke-width="1.1" stroke-linecap="round"/>`)
const ROW_HOVER = 'rgba(128,128,128,0.12)'
const SELF_BG = 'rgba(55,138,221,0.14)'
const CHIP_GREEN = 'rgba(29,158,117,0.14)'
const CHIP_GREY = 'rgba(128,128,128,0.12)'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sessions', description: 'Open the Sessions pane' })
    void $.ui.open({ id: PANE, title: 'Sessions' })
    void poll($)
    $.clock.every(10000, () => poll($))
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sessions' })
    await poll($)
    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const icon = (source: string, alt: string, size: number, glyph: string, color?: string) =>
      Svg ? <Svg source={source} alt={alt} width={size} height={size} /> : <Text color={color} dimColor={!color}>{glyph}</Text>
    const p = await read($, snap)
    const now = Date.now()
    const cutoff = now - RECENT_DAYS * 86400000
    const recent = p.sessions.filter(s => s.isRunning || (Date.parse(s.lastActivityAt) || 0) >= cutoff)
    const hidden = p.sessions.length - recent.length
    const groups = buildGroups(recent)
    const working = recent.filter(s => s.isRunning).length
    const chip = (key: string, bg: string, color: string | undefined, text: string) => (
      <Box key={key} backgroundColor={bg} paddingX={1}>
        <Text size="caption" color={color} dimColor={!color}>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1} alignItems="center">
            {chip('c:work', CHIP_GREEN, 'success', `${working} working`)}
            {chip('c:idle', CHIP_GREY, undefined, `${recent.length - working} idle`)}
          </Box>
          <Button key="refresh" label="Refresh" plain dimColor onPress={() => void poll($)} />
        </Box>
        {p.error !== null && <Text color="error">{`Couldn't read sessions: ${p.error}`}</Text>}
        {p.checkedAt === '' && <Text dimColor>Loading sessions…</Text>}
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
            {g.items.map(({ s, depth }) => (
              <Box
                key={`s:${s.id}`}
                flexDirection="row"
                gap={1}
                alignItems="center"
                paddingLeft={1 + depth * 2}
                paddingRight={1}
                backgroundColor={s.isSelf ? SELF_BG : undefined}
                hover={{ backgroundColor: ROW_HOVER }}
              >
                {depth > 0 && icon(CORNER, 'started by the session above', 12, '↳')}
                {s.isRunning ? icon(DOT_RUN, 'working', 10, '●', 'success') : icon(DOT_IDLE, 'idle', 10, '○')}
                <Box flexGrow={1} flexShrink={1}>
                  {s.link ? (
                    <Button
                      key={`open:${s.id}`}
                      plain
                      label={s.isSelf ? `${s.title} (this one)` : s.title}
                      dimColor={!s.isRunning && !s.isSelf}
                      onPress={() => void openSession($, s)}
                    />
                  ) : (
                    <Text wrap="truncate-end">{s.title}</Text>
                  )}
                </Box>
                {s.remote && icon(PHONE, 'Remote Control on', 12, 'RC')}
                <Text dimColor size="caption" tabular>{ago(s.lastActivityAt, now)}</Text>
              </Box>
            ))}
          </Box>
        ))}
        <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
          <Box flexDirection="row" gap={1} alignItems="center">{icon(DOT_RUN, '', 10, '●', 'success')}<Text size="caption" dimColor>Working</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{icon(DOT_IDLE, '', 10, '○')}<Text size="caption" dimColor>Idle</Text></Box>
          <Box flexDirection="row" gap={1} alignItems="center">{icon(PHONE, '', 12, 'RC')}<Text size="caption" dimColor>Remote</Text></Box>
          <Text size="caption" dimColor>
            {`${hidden > 0 ? `${hidden} older hidden · ` : ''}updated ${p.checkedAt ? ago(p.checkedAt, now) : '—'}`}
          </Text>
        </Box>
      </Box>
    )
  })
}
