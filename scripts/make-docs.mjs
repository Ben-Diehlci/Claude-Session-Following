// Makes the animated README pictures in docs/images from the mod's own drawing code.
// GitHub plays SMIL animation inside SVG images, so Clawd moves on the README page.
// Run: node scripts/make-docs.mjs   (all sessions shown are made-up examples)
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageSvg, esc, STAGE_W, STAGE_H } from '../hooks/stage.ts'
import { clawd, usageBar } from '../hooks/clawd.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images')
mkdirSync(OUT, { recursive: true })
const now = 0 // fixed, so the files only change when the drawing code does
const base = { now, working: [], waiting: 0, cheerTitle: null, hot: false }

// ---- stage scenes, on a white card so they read on GitHub's dark theme too ----
const card = (inner, w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="#ffffff" stroke="#e5e4df"/>${inner}</svg>`
const nest = (svg, x, y, w, h) => svg.replace('<svg ', `<svg x="${x}" y="${y}" `).replace(/ width="[0-9.]+" height="[0-9.]+"/, ` width="${w}" height="${h}"`)
const scenes = {
  'stage-working': { ...base, working: ['Fix the login page', 'Write release notes', 'Update the docs'] },
  'stage-needs-you': { ...base, waiting: 2, working: ['Fix the login page'] },
  'stage-quiet': base,
  'stage-finished': { ...base, cheerTitle: 'Write release notes' },
  'stage-hot': { ...base, working: ['Big refactor'], hot: true },
}
for (const [name, input] of Object.entries(scenes)) {
  writeFileSync(join(OUT, `${name}.svg`), card(nest(stageSvg(input), 10, 8, STAGE_W, STAGE_H), STAGE_W + 20, STAGE_H + 16))
}

// ---- a whole example panel ----
const W = 560
const F = 'font-family="-apple-system, system-ui, Segoe UI, sans-serif"'
const t = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" ${F} font-size="${o.size ?? 12}" fill="${o.fill ?? '#2c2c2a'}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(s)}</text>`
const pill = (x, y, s, bg, fg) => {
  const w = s.length * 6.4 + 14
  return { w, svg: `<rect x="${x}" y="${y}" width="${w}" height="18" rx="4" fill="${bg}"/>` + t(x + 7, y + 13, s, { size: 11, fill: fg }) }
}
const ring = (x, y) => `<circle cx="${x}" cy="${y}" r="3.75" fill="none" stroke="#888780" stroke-width="1.5"/>`
const pulse = (x, y) => `<circle cx="${x}" cy="${y}" r="4" fill="#EF9F27"><animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/></circle>`
const mini = (x, y) => nest(clawd('busy', 16, 12), x, y, 16, 12)
const phone = (x, y) => `<rect x="${x}" y="${y}" width="6" height="10" rx="1.3" fill="none" stroke="#888780" stroke-width="1.1"/>`
const badge = (x, y, s, bg, fg) => pill(x, y, s, bg, fg)
const OPUS = ['rgba(216,90,48,0.16)', '#993C1D'], SONNET = ['rgba(55,138,221,0.16)', '#185FA5']
let shimmerId = 0
const shimmer = (x, y, s) => {
  const id = `sh${shimmerId++}`
  return `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x - 120}" y1="0" x2="${x}" y2="0">` +
    `<stop offset="0" stop-color="#1D9E75"/><stop offset="0.5" stop-color="#9FE1CB"/><stop offset="1" stop-color="#1D9E75"/>` +
    `<animateTransform attributeName="gradientTransform" type="translate" values="0 0;${s.length * 7 + 240} 0" dur="2.4s" repeatCount="indefinite"/></linearGradient></defs>` +
    t(x, y, s, { fill: `url(#${id})`, weight: 600 })
}

let y = 0
let o = ''
// stage
o += nest(stageSvg({ ...base, working: ['Fix the login page', 'Write release notes'], waiting: 1 }), 12, 10, W - 24, Math.round(((W - 24) * STAGE_H) / STAGE_W))
y = 10 + Math.round(((W - 24) * STAGE_H) / STAGE_W) + 8
// pills + refresh
let px = 16
for (const [s, bg, fg] of [['1 needs you', 'rgba(239,159,39,0.2)', '#854F0B'], ['2 working', 'rgba(29,158,117,0.14)', '#0F6E56'], ['14 idle', 'rgba(128,128,128,0.12)', '#5F5E5A']]) {
  const p = pill(px, y, s, bg, fg); o += p.svg; px += p.w + 6
}
o += t(W - 16, y + 13, 'Refresh', { size: 12, fill: '#5F5E5A', anchor: 'end' })
y += 28
// usage table
o += `<rect x="12" y="${y}" width="${W - 24}" height="70" rx="4" fill="rgba(128,128,128,0.07)"/>`
for (const [i, [label, pct, reset]] of [['5-hour limit', 26, 'resets in 2h 42m'], ['Weekly · all models', 38, 'resets in 5h 2m'], ['Weekly · Fable', 13, 'resets in 5h 2m']].entries()) {
  const yy = y + 18 + i * 20
  o += t(22, yy, label, { size: 11, fill: '#5F5E5A' }) + nest(usageBar(pct, 140, '#1D9E75'), 160, yy - 7, 140, 6)
  o += t(338, yy, `${pct}%`, { size: 11, weight: 600, anchor: 'end' }) + t(350, yy, reset, { size: 11, fill: '#888780' })
}
y += 84
// needs you
o += pulse(18, y) + t(28, y + 4, 'Needs you', { size: 12, fill: '#854F0B', weight: 600 })
y += 10
o += `<rect x="12" y="${y}" width="${W - 24}" height="46" fill="rgba(239,159,39,0.1)"/>`
o += pulse(24, y + 14) + t(34, y + 18, 'Update the docs') + pill(150, y + 5, 'question', 'rgba(239,159,39,0.2)', '#854F0B').svg + t(W - 18, y + 18, 'waiting 3m', { size: 11, fill: '#888780', anchor: 'end' })
o += t(34, y + 37, 'Which changelog format should I use?', { size: 11, fill: '#854F0B' })
y += 60
// column labels
o += t(16, y, 'Environment · session', { size: 11, fill: '#888780' }) + t(W - 92, y, 'Remote', { size: 11, fill: '#888780', anchor: 'middle' }) + t(W - 18, y, 'Active', { size: 11, fill: '#888780', anchor: 'end' })
y += 10
// project card helper
const project = (name, area, counts, rows) => {
  const h = 30 + rows.length * 38 + 8
  let s = `<rect x="12" y="${y}" width="${W - 24}" height="${h}" rx="4" fill="rgba(128,128,128,0.07)"/>`
  s += `<rect x="12" y="${y}" width="${W - 24}" height="28" rx="4" fill="rgba(128,128,128,0.10)"/>`
  s += t(22, y + 18, '▾', { size: 10, fill: '#5F5E5A' }) + t(36, y + 18, name, { size: 13, weight: 600 })
  s += t(36 + name.length * 7.6 + 8, y + 18, area, { size: 11, fill: '#888780' })
  if (counts) s += pill(W - 190, y + 5, counts, 'rgba(29,158,117,0.14)', '#0F6E56').svg
  s += t(W - 18, y + 18, String(rows.length), { size: 11, fill: '#888780', anchor: 'end' })
  let ry = y + 30
  for (const r of rows) {
    const ix = 22 + (r.depth ? 18 : 0)
    if (r.depth) s += t(22, ry + 14, '↳', { size: 11, fill: '#888780' })
    s += r.working ? mini(ix - 2, ry + 4) : ring(ix + 5, ry + 10)
    s += r.working ? shimmer(ix + 20, ry + 14, r.title) : t(ix + 20, ry + 14, r.title)
    if (r.remote) s += phone(W - 95, ry + 5)
    s += t(W - 18, ry + 14, r.ago, { size: 11, fill: '#888780', anchor: 'end' })
    let bx = ix + 20
    const b = badge(bx, ry + 19, r.model, ...(r.model.startsWith('Opus') ? OPUS : SONNET)); s += b.svg; bx += b.w + 8
    s += t(bx, ry + 32, r.detail, { size: 11, fill: r.working ? '#0F6E56' : '#888780' })
    ry += 38
  }
  y += h + 10
  return s
}
o += project('website-redesign', 'Work', '2 working', [
  { title: 'Fix the login page', working: true, remote: true, ago: 'now', model: 'Opus 5.5', detail: 'high · working 6m · 3 helpers · 1 working' },
  { title: 'Write release notes', working: true, depth: 1, ago: 'now', model: 'Sonnet 5.5', detail: 'medium · working 2m' },
  { title: 'Check the staging site', depth: 1, remote: true, ago: '12m', model: 'Sonnet 5.5', detail: 'medium' },
])
o += project('home-automation', 'Personal', '', [
  { title: 'Thermostat schedule', remote: true, ago: '2h', model: 'Opus 5.5', detail: 'medium' },
])
o += t(16, y + 4, 'Show per project: 3 · [5] · 10 · All', { size: 11, fill: '#888780' })
y += 16
const H = y
writeFileSync(join(OUT, 'panel.svg'), card(o, W, H))
console.log('wrote', Object.keys(scenes).length + 1, 'pictures to docs/images')
