// Self-check for hooks/stage.ts: every scene returns well-formed SVG with no NaN/undefined.
// Run: node scripts/stage-selfcheck.mjs   (needs Node 22+ for TypeScript type stripping, else uses tsc output)
import { stageSvg, stageScene, stageText } from '../hooks/stage.ts'

const now = Date.now()
const base = { now, working: [], waiting: 0, cheerTitle: null, hot: false }
const cases = {
  quiet: base,
  'quiet+hot': { ...base, hot: true },
  working1: { ...base, working: ['Fix the <login> & "cache" bug'] },
  working4: { ...base, working: ['a', 'b', 'c', 'd'] },
  working6: { ...base, working: ['a', 'b', 'c', 'd', 'e', 'f'], hot: true },
  waiting: { ...base, waiting: 3, working: ['One', 'Two'] },
  'waiting-alone': { ...base, waiting: 1 },
  cheer: { ...base, cheerTitle: 'Build the thing & ship it, with a very long title indeed' },
  'cheer+hot': { ...base, cheerTitle: 'x', working: ['y'], hot: true },
  'bad-now': { ...base, now: NaN },
}
const expect = { quiet: 'quiet', working1: 'working', waiting: 'waiting', cheer: 'cheer' }
let bad = 0
const fail = (n, m) => { bad++; console.log(`FAIL ${n}: ${m}`) }

for (const [name, input] of Object.entries(cases)) {
  const svg = stageSvg(input)
  if (expect[name] && stageScene(input) !== expect[name]) fail(name, `scene ${stageScene(input)}`)
  if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>')) fail(name, 'not wrapped in <svg>')
  if (/NaN|undefined|Infinity|null/.test(svg)) fail(name, 'NaN/undefined in markup')
  if (svg.length > 131072) fail(name, 'over 131072 chars')
  // balanced tags
  const stack = []
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, , self] = m
    if (self) continue
    if (close) { if (stack.pop() !== tag) { fail(name, `unbalanced </${tag}>`); break } } else stack.push(tag)
  }
  if (stack.length) fail(name, `unclosed ${stack.join(',')}`)
  // text content must not contain raw < or & (escaped)
  for (const m of svg.matchAll(/>([^<]*)</g)) if (/&(?!amp;|lt;|gt;|quot;)/.test(m[1])) fail(name, 'raw & in text')
  if (!stageText(input)) fail(name, 'empty stageText')
  console.log(`ok   ${name} (${stageScene(input)}, ${svg.length} chars)`)
}
if (name_checks()) process.exit(1)
function name_checks() { console.log(bad ? `${bad} failure(s)` : 'all scenes well-formed'); return bad > 0 }
