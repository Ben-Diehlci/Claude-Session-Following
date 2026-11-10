// Clawd's stage: an animated strip across the top of the pane (SVG with SMIL, no timers).
// Every animation starts with a NEGATIVE begin = (wall clock mod its period), so a redraw continues the
// motion where it already was instead of restarting it.
export type StageInput = {
  /** Wall clock, epoch ms (Date.now()). */
  now: number
  /** Titles of the working sessions. */
  working: string[]
  /** How many sessions are waiting on the person. */
  waiting: number
  /** Title of the session that just finished while Clawd is still cheering; null when not cheering. */
  cheerTitle: string | null
  /** Any usage window above 80 percent. */
  hot: boolean
}
export type StageScene = 'cheer' | 'waiting' | 'working' | 'quiet'

export const STAGE_W = 600
export const STAGE_H = 64
const FLOOR = 58
const BODY = '#D77757'
const EYE = '#2C2C2A'
const GREY = '#888780'
const GREEN = '#1D9E75'
const AMBER = '#EF9F27'
const BLUE = '#378ADD'
const PINK = '#D4537E'
const DESKS_MAX = 4
const DESK_X0 = 112
const DESK_W = 112
const FONT = 'font-family="system-ui, sans-serif"'

export const stageScene = (i: StageInput): StageScene =>
  i.waiting > 0 ? 'waiting' : i.cheerTitle !== null ? 'cheer' : i.working.length > 0 ? 'working' : 'quiet'

const num = (n: number): string => (Number.isFinite(n) ? String(+n.toFixed(2)) : '0')
export const esc = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t
}

/** Wall-clock phase: begin offset so an animation of `ms` period is `shift` ms along when drawn at `now`. */
const begin = (now: number, ms: number, shift = 0): string => ` begin="${num(-(((now + shift) % ms) + ms) % ms / 1000)}s"`
const rep = (ms: number): string => ` dur="${num(ms / 1000)}s" repeatCount="indefinite"`

const r = (x: number, y: number, w: number, h: number, fill: string, extra = ''): string =>
  `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${fill}"${extra}/>`

type Look = { arms?: 'down' | 'wave' | 'up'; legs?: 'stand' | 'walk' }

/** Standing Clawd in grid units (16x12; drawn at 2x by the caller). */
const standing = (now: number, look: Look): string => {
  const arms = look.arms ?? 'down'
  let o = r(2, 1, 12, 8, BODY) + r(4, 3, 2, 2, EYE) + r(10, 3, 2, 2, EYE)
  if (arms === 'down') o += r(0, 4, 2, 2, BODY) + r(14, 4, 2, 2, BODY)
  else if (arms === 'up') o += r(0, 0, 2, 4, BODY) + r(14, 0, 2, 4, BODY)
  else
    o +=
      r(0, 4, 2, 2, BODY) +
      `<g>${r(14, 0, 2, 5, BODY)}<animateTransform attributeName="transform" type="rotate" values="-18 15 5;18 15 5;-18 15 5"${rep(500)}${begin(now, 500)}/></g>`
  if (look.legs === 'walk') {
    const leg = (x: number, vals: string) =>
      `<rect x="${x}" y="9" width="1" height="3" fill="${BODY}"><animate attributeName="height" calcMode="discrete" values="${vals}"${rep(400)}${begin(now, 400)}/></rect>`
    o += leg(3, '3;1') + leg(9, '3;1') + leg(6, '1;3') + leg(12, '1;3')
  } else o += [3, 6, 9, 12].map(x => r(x, 9, 1, 3, BODY)).join('')
  return o
}

/** Flattened sleeping Clawd, eyes as 1px lines. */
const sleeping = (): string =>
  r(2, 6, 12, 4, BODY) + r(0, 7, 2, 2, BODY) + r(14, 7, 2, 2, BODY) + r(4, 8, 2, 1, EYE) + r(10, 8, 2, 1, EYE) +
  [3, 6, 9, 12].map(x => r(x, 10, 1, 2, BODY)).join('')

/** Sweat drops and a waving paper fan, in strip pixels relative to the 32x24 Clawd box. */
const hotBits = (now: number): string => {
  const drop = (x: number, shift: number) =>
    `<path d="M${x} 6 q-2 3-2 4.5 a2 2 0 0 0 4 0 q0-1.5-2-4.5z" fill="${BLUE}" opacity="0">` +
    `<animateTransform attributeName="transform" type="translate" values="0 0;0 9" keyTimes="0;1"${rep(1200)}${begin(now, 1200, shift)}/>` +
    `<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.2;1"${rep(1200)}${begin(now, 1200, shift)}/></path>`
  const fan =
    `<g><g transform="translate(-9 14)">${r(-1, -3, 11, 7, '#F4D58D', ' stroke="#BA7517" stroke-width="0.8"')}${r(9, -0.5, 4, 2, '#BA7517')}</g>` +
    `<animateTransform attributeName="transform" type="rotate" values="-22 -2 17;22 -2 17;-22 -2 17"${rep(320)}${begin(now, 320)}/></g>`
  return drop(31, 0) + drop(1, 600) + fan
}

/** Places a Clawd drawing with its feet on the floor at strip x; `move` is extra SMIL for the group. */
const place = (x: number, body: string, extra = '', anim = ''): string =>
  `<g transform="translate(${num(x)} ${FLOOR - 24})"><g>${anim}<g transform="scale(2)">${body}</g>${extra}</g></g>`

const slide = (values: string, keyTimes: string, ms: number, now: number): string =>
  `<animateTransform attributeName="transform" type="translate" values="${values}" keyTimes="${keyTimes}"${rep(ms)}${begin(now, ms)}/>`

const desk = (x0: number, title: string, now: number, k: number): string => {
  const typing = `<animateTransform attributeName="transform" type="translate" values="0 0;0 1;0 0"${rep(400)}${begin(now, 400, k * 130)}/>`
  return (
    `<text x="${num(x0 + 36)}" y="11" text-anchor="middle" font-size="8.5" ${FONT} fill="${GREY}">${esc(clip(title, 22))}</text>` +
    place(x0 + 6, standing(now, {}), '', typing) +
    r(x0, 48, 72, 3, '#8A6A4A') + r(x0 + 4, 51, 3, 7, '#8A6A4A') + r(x0 + 65, 51, 3, 7, '#8A6A4A') +
    r(x0 + 40, 46, 30, 2, '#5F5E5A') +
    r(x0 + 45, 36, 20, 10, EYE, ' rx="1"') +
    `<rect x="${num(x0 + 47)}" y="38" width="16" height="6" fill="${GREEN}"><animate attributeName="opacity" values="1;0.35;1"${rep(1100)}${begin(now, 1100, k * 290)}/></rect>`
  )
}

const confetti = (now: number): string => {
  const cols = [AMBER, GREEN, BLUE, PINK]
  let o = ''
  for (let i = 0; i < 18; i++) {
    const ms = 2000 + (i % 4) * 400
    const x = 8 + ((i * 97) % 580)
    const drift = (i % 2 ? 1 : -1) * (6 + (i % 5) * 3)
    o +=
      `<rect x="${x}" y="-4" width="${3 + (i % 2)}" height="${3 + ((i + 1) % 2)}" fill="${cols[i % 4]}">` +
      `<animateTransform attributeName="transform" type="translate" values="0 0;${drift} ${STAGE_H + 8}"${rep(ms)}${begin(now, ms, i * 173)}/></rect>`
  }
  return o
}

/** Three z's floating up from the napping Clawd (strip pixels, relative to his box). */
const zs = (now: number): string => {
  let o = ''
  for (let i = 0; i < 3; i++) {
    o +=
      `<text x="26" y="8" font-size="${7 + i * 2}" font-weight="700" ${FONT} fill="${GREY}" opacity="0">z` +
      `<animateTransform attributeName="transform" type="translate" values="0 0;8 -${22}"${rep(3000)}${begin(now, 3000, i * 1000)}/>` +
      `<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.3;1"${rep(3000)}${begin(now, 3000, i * 1000)}/></text>`
  }
  return o
}

export const stageSvg = (input: StageInput): string => {
  const now = Number.isFinite(input.now) ? input.now : 0
  const scene = stageScene(input)
  const hot = input.hot ? hotBits(now) : ''
  const shown = input.working.slice(0, DESKS_MAX)
  let o = r(0, FLOOR, STAGE_W, 1, GREY, ' opacity="0.45"')

  if (scene === 'quiet') {
    // 30 s window: asleep until 80 percent, then up for a short lap, then back to bed.
    const ms = 30000
    const vis = (a: string, b: string) =>
      `<animate attributeName="visibility" calcMode="discrete" values="${a};${b}" keyTimes="0;0.8"${rep(ms)}${begin(now, ms)}/>`
    const lap = slide('0 0;0 0;80 0;0 0', '0;0.8;0.9;1', ms, now)
    o +=
      `<g>${vis('visible', 'hidden')}${place(280, sleeping(), zs(now) + hot)}</g>` +
      `<g visibility="hidden">${vis('hidden', 'visible')}${place(280, standing(now, { legs: 'walk' }), hot, lap)}</g>`
  } else {
    if (scene === 'working') {
      // one Clawd strolling there and back behind the desks
      o += place(10, standing(now, { legs: 'walk' }), hot, slide('0 0;540 0;0 0', '0;0.5;1', 24000, now))
    }
    shown.forEach((t, k) => (o += desk(DESK_X0 + k * DESK_W, t, now, k)))
    if (input.working.length > DESKS_MAX)
      o += `<text x="${STAGE_W - 4}" y="52" text-anchor="end" font-size="9" ${FONT} fill="${GREY}">+${input.working.length - DESKS_MAX} more</text>`
    if (scene === 'waiting') {
      const label = `${input.waiting} need you`
      const sw = Math.max(54, label.length * 6 + 12)
      const sign =
        `<g transform="translate(30 -22)">${r(0, 0, sw, 16, '#FAEEDA', ` rx="3" stroke="${AMBER}" stroke-width="1.5"`)}` +
        `<text x="${num(sw / 2)}" y="11.5" text-anchor="middle" font-size="10" font-weight="700" ${FONT} fill="#854F0B">${esc(label)}</text>` +
        `${r(sw / 2 - 1, 16, 2, 4, '#854F0B')}</g>`
      const dash = slide('0 0;470 0;470 0;0 0;0 0', '0;0.45;0.5;0.95;1', 6000, now)
      o += place(10, standing(now, { arms: 'wave', legs: 'walk' }), sign + hot, dash)
    } else if (scene === 'cheer') {
      const jump = `<animateTransform attributeName="transform" type="translate" values="0 0;0 -14;0 0" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.3 0 0.7 1;0.3 0 0.7 1"${rep(700)}${begin(now, 700)}/>`
      const title = clip(input.cheerTitle ?? '', 30)
      o += place(40, standing(now, { arms: 'up' }), hot, jump)
      o += `<text x="86" y="29" font-size="12" font-weight="700" ${FONT} fill="${GREEN}">${esc(title ? `${title} is done` : 'Done')}</text>`
      o += confetti(now)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STAGE_W}" height="${STAGE_H}" viewBox="0 0 ${STAGE_W} ${STAGE_H}" shape-rendering="crispEdges">${o}</svg>`
}

/** Short description for the Svg alt text and the terminal fallback. */
export const stageText = (i: StageInput): string => {
  const hot = i.hot ? ' (and hot)' : ''
  switch (stageScene(i)) {
    case 'waiting': return `Clawd is waving a sign: ${i.waiting} need you${hot}`
    case 'cheer': return `Clawd is cheering: ${clip(i.cheerTitle ?? '', 40) || 'a session'} is done${hot}`
    case 'working': return `Clawd is typing at ${i.working.length} desk${i.working.length === 1 ? '' : 's'}${hot}`
    default: return `Clawd is asleep, all quiet${hot}`
  }
}
