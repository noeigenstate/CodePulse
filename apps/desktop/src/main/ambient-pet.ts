import {
  PET_IDS,
  PET_PROFILES,
  TurnState,
  type AmbientCard,
  type PetId,
  type PetMood,
  type StatusSnapshot,
} from '@codepulse/shared'
import { renderPetArt } from './ambient-pet-art.js'

/** One short line per pet and mood, drawn by the device under the picture (about 20 characters). */
export const PET_LINES: Record<PetId, Record<PetMood, string>> = {
  tuantuan: {
    idle: '我在晒太阳，你忙你的。',
    working: '你敲你的，我替你盯着。',
    hungry: '额度见底了……能续点口粮吗？',
    happy: '搞定啦！今晚的小鱼干有着落了。',
    sleepy: '夜深了，我先窝着，晚安。',
  },
  yaya: {
    idle: '我在长高，你也慢慢来。',
    working: '戴上眼镜，陪你一起看。',
    hungry: '叶子耷拉了，浇点额度吧。',
    happy: '你又长出一片新叶子！',
    sleepy: '光合作用暂停，明早见。',
  },
  fangfang: {
    idle: '系统待机，心情平稳。',
    working: 'Agent 在跑，我在旁边待命。',
    hungry: '电量告急，求一格额度。',
    happy: '任务完成，开心指数 100%。',
    sleepy: '进入夜间模式，晚安。',
  },
}

const ACTIVE_WORK: readonly string[] = [
  TurnState.PROMPT_SUBMITTED,
  TurnState.THINKING,
  TurnState.TOOL_RUNNING,
]
const HUNGRY_BELOW_REMAINING = 20
const HAPPY_WINDOW_MS = 2 * 3600000

/** Smallest remaining quota (percent) among windows that have not already reset, or 100. */
function lowestRemaining(status: StatusSnapshot, now: number): number {
  let remaining = 100
  for (const agent of status.agents) {
    const token = agent.token
    for (const limits of [
      token?.rateLimits,
      ...Object.values(token?.quotaBuckets ?? {}).map((b) => b.rateLimits),
    ])
      for (const window of [limits?.fiveHour, limits?.sevenDay]) {
        if (
          !window ||
          typeof window.usedPercent !== 'number' ||
          !Number.isFinite(window.usedPercent)
        )
          continue
        if (typeof window.resetsAt === 'number' && window.resetsAt * 1000 <= now) continue // Already reset.
        remaining = Math.min(remaining, 100 - Math.max(0, Math.min(100, window.usedPercent)))
      }
  }
  return remaining
}

/**
 * The pet's mood from live work status and the local clock. The first match wins:
 * 1. sleepy  - local time from 23:00 to 06:59, whatever else is going on;
 * 2. hungry  - any quota window that has not reset has 20% or less left;
 * 3. working - an Agent is submitting, thinking or running a tool;
 * 4. happy   - an Agent finished (DONE) within the last 2 hours;
 * 5. idle    - everything else.
 * Active work outranks the afterglow of an old finish, so a busy desk never looks idle.
 */
export function petMood(status: StatusSnapshot, now: number): PetMood {
  const hour = new Date(now).getHours()
  if (hour >= 23 || hour < 7) return 'sleepy'
  if (lowestRemaining(status, now) <= HUNGRY_BELOW_REMAINING) return 'hungry'
  const agents = status.agents.filter((a) => !a.taskHidden)
  if (agents.some((a) => ACTIVE_WORK.includes(a.state))) return 'working'
  if (
    agents.some(
      (a) =>
        a.state === TurnState.DONE &&
        typeof a.terminalAt === 'number' &&
        a.terminalAt <= now + 60000 &&
        now - a.terminalAt <= HAPPY_WINDOW_MS,
    )
  )
    return 'happy'
  return 'idle'
}

/**
 * One card per pet, drawn for the current mood. The id carries the pet, the mood and the local
 * date, so a card that is on screen never changes with live status: a showing costs exactly one
 * full refresh in and one out, and each pet/mood is offered at most once a day.
 */
export function petCards(status: StatusSnapshot, now: number): AmbientCard[] {
  const mood = petMood(status, now)
  const date = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  date.setHours(0, 0, 0, 0)
  return PET_IDS.map((id) => {
    const art = renderPetArt(id, mood)
    return {
      id: `pet:${id}:${mood}:${day}`,
      kind: 'pet',
      source: `像素宠物 · ${PET_PROFILES[id].name}`,
      text: PET_LINES[id][mood],
      url: '',
      publishedAt: date.getTime(),
      expiresAt: now + 86400000,
      score: 0,
      imageHex: art.imageHex,
      ...(art.red ? { red: art.red } : {}),
      layout: 'pet',
      pet: { id, mood },
    }
  })
}
