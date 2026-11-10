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
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, snap)
    const now = Date.now()
    const cutoff = now - RECENT_DAYS * 86400000
    const recent = p.sessions.filter(s => s.isRunning || (Date.parse(s.lastActivityAt) || 0) >= cutoff)
    const hidden = p.sessions.length - recent.length
    const groups = buildGroups(recent)
    const working = recent.filter(s => s.isRunning).length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text>
            <Text color="success" bold>{`● ${working} working`}</Text>
            <Text dimColor>{`   ○ ${recent.length - working} idle`}</Text>
          </Text>
          <Button key="refresh" label="Refresh" plain onPress={() => void poll($)} />
        </Box>
        {p.error !== null && <Text color="error">{`Couldn't read sessions: ${p.error}`}</Text>}
        {p.checkedAt === '' && <Text dimColor>Loading sessions…</Text>}
        {groups.map(g => (
          <Box key={`g:${g.key}`} flexDirection="column">
            <Text dimColor size="footnote" wrap="truncate-end">
              {`▸ ${g.name}${g.area ? `  ·  ${g.area}` : ''}  (${g.items.length})`}
            </Text>
            {g.items.map(({ s, depth }) => (
              <Box key={`s:${s.id}`} flexDirection="row" gap={1} paddingLeft={depth * 2}>
                <Text color={s.isRunning ? 'success' : 'inactive'}>{depth > 0 ? '↳ ●' : '●'}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  {s.link ? (
                    <Button
                      key={`open:${s.id}`}
                      plain
                      label={s.isSelf ? `${s.title} (this one)` : s.title}
                      dimColor={!s.isRunning}
                      onPress={() => void openSession($, s)}
                    />
                  ) : (
                    <Text wrap="truncate-end">{s.title}</Text>
                  )}
                </Box>
                {s.remote && <Text dimColor size="caption">RC</Text>}
                <Text dimColor size="caption" tabular>{ago(s.lastActivityAt, now)}</Text>
              </Box>
            ))}
          </Box>
        ))}
        <Text dimColor size="caption">
          {`${hidden > 0 ? `${hidden} idle for over ${RECENT_DAYS} days hidden · ` : ''}RC = Remote Control · updated ${p.checkedAt ? ago(p.checkedAt, now) : '—'}`}
        </Text>
      </Box>
    )
  })
}
