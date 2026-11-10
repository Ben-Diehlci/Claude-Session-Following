// Clawd: a 16x12 pixel mascot drawn as SVG. Grid per the approved drawing.
export type Mood = 'busy' | 'asleep' | 'cheering' | 'waving' | 'worried'

const BODY = '#D77757'
const EYE = '#2C2C2A'
const SPARK = '#EF9F27'
const ZZZ = '#888780'

const r = (x: number, y: number, w: number, h: number, fill: string, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra ? ' ' + extra : ''}/>`

const bob = (dy: number, dur: string) =>
  `<animateTransform attributeName="transform" type="translate" values="0 0;0 ${dy};0 0" dur="${dur}" repeatCount="indefinite"/>`

const blink = (dur: string, from = 1, to = 0.15) =>
  `<animate attributeName="opacity" values="${from};${to};${from}" dur="${dur}" repeatCount="indefinite"/>`

export function clawd(mood: Mood, w: number, h: number): string {
  // four evenly spaced legs under the body
  const legs = [3, 6, 9, 12].map(x => r(x, 9, 1, 2, BODY)).join('')
  let top = ''
  switch (mood) {
    case 'busy':
      top = `<g>${bob(-0.8, '0.5s')}${r(2, 1, 12, 8, BODY)}${r(0, 4, 2, 2, BODY)}${r(14, 4, 2, 2, BODY)}${r(4, 3, 2, 2, EYE)}${r(10, 3, 2, 2, EYE)}</g>`
      break
    case 'asleep':
      top =
        `${r(2, 1, 12, 8, BODY)}${r(0, 4, 2, 2, BODY)}${r(14, 4, 2, 2, BODY)}${r(4, 4, 2, 1, EYE)}${r(10, 4, 2, 1, EYE)}` +
        `<text x="12.5" y="3" font-size="3.4" font-family="sans-serif" font-weight="700" fill="${ZZZ}">z${blink('2.4s', 1, 0.2)}<animateTransform attributeName="transform" type="translate" values="0 1.5;0 -1;0 1.5" dur="2.4s" repeatCount="indefinite"/></text>`
      break
    case 'cheering':
      top =
        `<g>${bob(-1.2, '0.4s')}${r(2, 1, 12, 8, BODY)}${r(0, 2, 2, 2, BODY)}${r(14, 2, 2, 2, BODY)}${r(4, 3, 2, 2, EYE)}${r(10, 3, 2, 2, EYE)}</g>` +
        `<g fill="${SPARK}">${r(0, 0, 1, 1, SPARK, '')}${r(15, 0, 1, 1, SPARK)}${r(7, 0, 1, 1, SPARK)}<animate attributeName="opacity" values="1;0.1;1" dur="0.5s" repeatCount="indefinite"/></g>` +
        `<g fill="${SPARK}">${r(2, 0, 1, 1, SPARK)}${r(13, 0, 1, 1, SPARK)}<animate attributeName="opacity" values="0.1;1;0.1" dur="0.5s" repeatCount="indefinite"/></g>`
      break
    case 'waving':
      top =
        `${r(2, 1, 12, 8, BODY)}${r(0, 4, 2, 2, BODY)}${r(4, 3, 2, 2, EYE)}${r(10, 3, 2, 2, EYE)}` +
        `<g>${r(14, 4, 2, 2, BODY)}${r(14, 1, 2, 3, BODY)}<animateTransform attributeName="transform" type="rotate" values="-12 14 5;12 14 5;-12 14 5" dur="0.7s" repeatCount="indefinite"/></g>`
      break
    case 'worried':
      top = `${r(2, 1, 12, 8, BODY)}${r(0, 4, 2, 2, BODY)}${r(14, 4, 2, 2, BODY)}${r(4, 3, 2, 2, EYE)}${r(10, 3, 2, 2, EYE)}${r(7, 6, 2, 1, EYE)}${r(6, 7, 1, 1, EYE)}${r(9, 7, 1, 1, EYE)}`
      break
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 16 12" shape-rendering="crispEdges">${legs}${top}</svg>`
}

/** Amber pulsing dot for "needs you". */
export function pulseDot(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="${color}"><animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/></circle></svg>`
}

/** Horizontal usage bar. pct 0-100. */
export function usageBar(pct: number, w: number, color: string): string {
  const p = Math.max(0, Math.min(100, pct))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6"><rect width="${w}" height="6" rx="3" fill="rgba(128,128,128,0.25)"/><rect width="${Math.max(p > 0 ? 3 : 0, (w * p) / 100)}" height="6" rx="3" fill="${color}"/></svg>`
}
