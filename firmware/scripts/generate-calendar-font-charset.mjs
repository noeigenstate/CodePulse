// Read-only extraction from the desktop calendar, never from a running app.
// node scripts/generate-calendar-font-charset.mjs --module <calendar directory> [--check]
import { registerHooks } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const args = process.argv.slice(2), moduleAt = args.indexOf('--module')
if (moduleAt < 0 || !args[moduleAt + 1]) throw new Error('Supply --module <desktop calendar directory>')
const directory = resolve(args[moduleAt + 1])
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('./') && specifier.endsWith('.js') && context.parentURL?.startsWith(pathToFileURL(directory).href)) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
  }
  return next(specifier, context)
} })
const { buildMonthCalendar, lunarDate } = await import(pathToFileURL(join(directory, 'index.ts')).href)
const labels = new Set(), lunarChars = new Set()
let days = 0
for (let year = 1900; year <= 2100; year++) for (let month = 0; month < 12; month++) {
  const calendar = buildMonthCalendar(new Date(year, month, 1, 12))
  calendar.labels.forEach(s => labels.add(s))
  for (let day = 1; day <= calendar.days; day++) {
    const lunar = lunarDate(new Date(year, month, day, 12))
    for (const ch of `${lunar.ganzhiYear}年${lunar.monthName}${lunar.dayName}`) lunarChars.add(ch)
    days++
  }
}
const fixed = '一二三四五六日第周班年月'
// Preserve the approved long-label and native-bearing stress specimens too.
const compatibility = ['春节快乐', '四字标签', 'Ág中']
const codepoints = [...new Set([...labels].join('') + [...lunarChars].join('') + fixed + compatibility.join(''))]
  .map(c => c.codePointAt(0)).sort((a, b) => a - b)
const sourceNames = ['civil.ts', 'data.ts', 'holidays.ts', 'index.ts', 'lunar.ts', 'solar-terms.ts']
const sourceHashes = Object.fromEntries(sourceNames.map(name => [name,
  createHash('sha256').update(readFileSync(join(directory, name), 'utf8').replaceAll('\r\n', '\n')).digest('hex')]))
const result = { range: [1900, 2100], months: 201 * 12, days, sourceHashes,
  labels: [...labels].sort(), lunarCharacters: [...lunarChars].sort().join(''), fixed, compatibility, codepoints }
const output = fileURLToPath(new URL('../fonts/sources/calendar-charset.json', import.meta.url))
const json = JSON.stringify(result, null, 2) + '\n'
if (args.includes('--check')) {
  if (readFileSync(output, 'utf8').replaceAll('\r\n', '\n') !== json) throw new Error('Stale calendar charset; regenerate and review')
} else writeFileSync(output, json)
console.log(`Calendar charset: ${codepoints.length} codepoints, ${labels.size} labels, ${days} civil days, ${result.months} months; ${args.includes('--check') ? 'verified' : 'written'}`)
