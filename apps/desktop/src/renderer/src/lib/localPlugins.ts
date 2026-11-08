import {
  petProfile,
  type AmbientCard,
  type AmbientConfig,
  type AmbientSnapshot,
  type InkDisplayPlan,
  type YuanbaoTopic,
} from '@codepulse/shared'
import { cardCategory, categoryProblem, type AmbientCategory } from './ambientStatus.js'
import { yuanbaoRowError } from './yuanbaoStatus.js'
import { needsPluginSetup } from './pluginPresentation.js'
import { lifeRowOn, lifeTripleOf } from './yuanbaoRows.js'

export type Category = Exclude<AmbientCategory, 'plugin'>
export type YuanbaoCategory = 'life' | 'tools' | 'holiday' | 'headlines'
export const isYuanbao = (id: Category): id is YuanbaoCategory =>
  id === 'life' || id === 'tools' || id === 'holiday' || id === 'headlines'
/** The list order is the page order: a category row is the category's own *Enabled rule. */
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'concept', label: '概念卡' },
  { id: 'prompt', label: '思考实验' },
  { id: 'pet', label: '像素宠物' },
  { id: 'calendar', label: '日历' },
  { id: 'news', label: '科技热议' },
  { id: 'social', label: 'X 与 meme' },
  { id: 'local', label: '我的图片与便签' },
  { id: 'life', label: '生活卡' },
  { id: 'tools', label: '工具更新' },
  { id: 'holiday', label: '假日公告' },
  { id: 'headlines', label: '今日要闻' },
]
export const RULE_FLAG: Partial<
  Record<
    Category,
    'conceptsEnabled' | 'promptsEnabled' | 'petEnabled' | 'calendarEnabled' | 'newsEnabled'
  >
> = {
  concept: 'conceptsEnabled',
  prompt: 'promptsEnabled',
  pet: 'petEnabled',
  calendar: 'calendarEnabled',
  news: 'newsEnabled',
}

export function localPluginEnabled(id: Category, config: AmbientConfig): boolean {
  if (id === 'life') return lifeRowOn(lifeTripleOf(config.yuanbao))
  if (id === 'tools') return config.yuanbao.toolsEnabled
  if (id === 'holiday') return config.yuanbao.holidayEnabled
  if (id === 'headlines') return config.yuanbao.newsEnabled
  if (id === 'social') return config.xEnabled || config.memeEnabled
  const flag = RULE_FLAG[id]
  return flag ? config[flag] : false
}

export function localPluginRows(snapshot: AmbientSnapshot | undefined, config: AmbientConfig) {
  return CATEGORIES.map(({ id, label }) => {
    const needsYuanbaoKey = isYuanbao(id) && !snapshot?.yuanbao?.hasKey
    const needsSocialKey = id === 'social' && config.xEnabled && !snapshot?.hasKey
    const needsKey = needsYuanbaoKey || needsSocialKey
    const enabled = localPluginEnabled(id, config)
    const error =
      categoryProblem(id, snapshot?.sourceStatus, {
        x: config.xEnabled,
        meme: config.memeEnabled,
        news: config.newsEnabled,
      }) || (isYuanbao(id) && enabled ? yuanbaoRowError(id, snapshot?.yuanbao?.errors) : '')
    const count = snapshot?.cards.filter((card) => cardCategory(card) === id).length ?? 0
    return {
      id: `local:${id}`,
      category: id,
      name: label,
      enabled: id === 'local' ? null : !needsYuanbaoKey && enabled,
      disabled: !snapshot || needsYuanbaoKey,
      count: id === 'pet' ? Math.min(1, count) : count,
      state:
        id === 'local'
          ? '仅手动'
          : needsKey
            ? '需要设置'
            : !enabled
              ? '已关闭'
              : error
                ? needsPluginSetup(error)
                  ? '需要设置'
                  : '生成失败'
                : '正常',
      reason: needsKey ? (needsYuanbaoKey ? '请先填写元宝搜索密钥' : '请先填写 X API 密钥') : error,
    }
  })
}

/** Keep work and the other plugin slot intact when changing one automatic display switch. */
export function pluginInkPlan(
  plan: InkDisplayPlan,
  feature: 'ambient' | 'todos',
  enabled: boolean,
): InkDisplayPlan {
  const items = plan.items.filter((id) => id !== feature)
  return { ...plan, mode: 'cycle', items: enabled ? [...items, feature] : items }
}

/** Built-in samples shown (tagged 示例) while a 元宝搜索 category has no card yet. */
export const SAMPLES: Record<YuanbaoCategory, { topic: YuanbaoTopic; label: string }[]> = {
  life: [
    { topic: 'weather', label: '天气' },
    { topic: 'gold', label: '金价' },
    { topic: 'stock', label: '股价' },
  ],
  tools: [{ topic: 'tools', label: '工具更新' }],
  holiday: [{ topic: 'holiday', label: '假日公告' }],
  headlines: [{ topic: 'news', label: '今日要闻' }],
}

/** Let the renderer clamp rows visually without discarding content before it can wrap. */
export function localPluginItemLabel(card: AmbientCard): string {
  if (card.pet) return petProfile(card.pet.id).name
  if (card.kind === 'calendar') return card.text
  const text = card.text.replace(/\s+/g, ' ')
  return ['x', 'meme', 'news'].includes(card.kind) ? `${card.source} · ${text}` : text
}
