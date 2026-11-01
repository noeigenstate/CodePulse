import { civilDate } from './civil.js'
import { SOLAR_TERM_DAYS } from './data.js'

const TERMS = [
  '小寒',
  '大寒',
  '立春',
  '雨水',
  '惊蛰',
  '春分',
  '清明',
  '谷雨',
  '立夏',
  '小满',
  '芒种',
  '夏至',
  '小暑',
  '大暑',
  '立秋',
  '处暑',
  '白露',
  '秋分',
  '寒露',
  '霜降',
  '立冬',
  '小雪',
  '大雪',
  '冬至',
]

/** Published Chinese civil dates, rather than the caller's timezone's astronomical instants. */
export function solarTerm(date: Date): string | undefined {
  const { year, month, day } = civilDate(date)
  const index = (month - 1) * 2
  const days = SOLAR_TERM_DAYS[year - 1900]!
  for (const i of [index, index + 1]) if (parseInt(days[i]!, 36) === day) return TERMS[i]
  return undefined
}
