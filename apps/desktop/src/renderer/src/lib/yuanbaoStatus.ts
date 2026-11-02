import type { YuanbaoAuthMode, YuanbaoTopic } from '@codepulse/shared'

export type YuanbaoRowId = 'life' | 'tools' | 'holiday' | 'headlines'

/** Which topics each row owns: 生活卡 covers weather, gold and stock; the others one each. */
const ROW_TOPICS: Record<YuanbaoRowId, YuanbaoTopic[]> = {
  life: ['weather', 'gold', 'stock'],
  tools: ['tools'],
  holiday: ['holiday'],
  headlines: ['news'],
}

/** The error to show inside a 元宝搜索 row: only its own topics' errors, never the global one. */
export function yuanbaoRowError(row: YuanbaoRowId, errors: Partial<Record<YuanbaoTopic, string>> | undefined): string {
  for (const topic of ROW_TOPICS[row]) {
    const text = errors?.[topic]?.trim()
    if (text) return text
  }
  return ''
}

/**
 * The auth mode the key form shows. Until the user touches the mode switch it follows the host
 * (so an API-key user sees API Key mode, 已保存 and an enabled 清除); afterwards their choice wins.
 */
export function syncAuthMode(
  current: YuanbaoAuthMode,
  touched: boolean,
  hostMode: YuanbaoAuthMode | null | undefined,
): YuanbaoAuthMode {
  return !touched && hostMode ? hostMode : current
}
