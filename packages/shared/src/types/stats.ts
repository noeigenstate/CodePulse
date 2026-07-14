/**
 * 本地开发数据统计（后台大屏）共享类型。
 *
 * 数据仅来自本机 SQLite，不上传云端。
 *
 * @module shared/types/stats
 */

/** 统计时间范围预设。 */
export type StatsRangePreset = 'today' | '7d' | '30d'

/** 趋势图粒度。 */
export type StatsTrendGranularity = 'day' | 'week' | 'month'

/** KPI 卡片上的环比变化。 */
export interface StatsDelta {
  /** 相对上一周期的变化比例（0.186 = +18.6%）；绝对项用 absolute。 */
  ratio?: number
  /** 绝对变化量（如项目数 +2）。 */
  absolute?: number
  /** 是否有上一周期可比较的数据。 */
  comparable: boolean
}

/** 概览 KPI。 */
export interface StatsKpis {
  totalTokens: number
  totalDurationMs: number
  projectCount: number
  dialogCount: number
  avgDailyTokens: number
  avgDailyDurationMs: number
  deltas: {
    totalTokens: StatsDelta
    totalDurationMs: StatsDelta
    projectCount: StatsDelta
    dialogCount: StatsDelta
    avgDailyTokens: StatsDelta
    avgDailyDurationMs: StatsDelta
  }
}

/** 时间序列点（趋势图）。 */
export interface StatsTrendPoint {
  /** 桶起始时间 epoch ms。 */
  bucketStart: number
  /** 展示用标签，如 06-01 或 06-05（周三）。 */
  label: string
  tokens: number
  durationMs: number
  dialogs: number
}

/** 模型占比。 */
export interface StatsModelShare {
  model: string
  tokens: number
  percent: number
}

/** 项目消耗排行。 */
export interface StatsProjectRank {
  name: string
  path: string
  tokens: number
  tokenShare: number
  durationMs: number
  dialogCount: number
  lastActiveAt: number
}

/** 使用洞察。 */
export interface StatsInsight {
  id: string
  kind: 'peak_day' | 'top_model' | 'efficiency' | 'info'
  /** 预渲染的中文/英文文案由渲染层格式化；这里给结构化字段。 */
  titleKey: string
  detailKey: string
  params: Record<string, string | number>
}

/** 分类占比（项目类型 / 文件类型）。 */
export interface StatsCategoryShare {
  key: string
  labelKey: string
  count: number
  percent: number
}

/** 单次对话 token 分桶。 */
export interface StatsDialogBucket {
  key: string
  labelKey: string
  count: number
}

/** 高峰时段热力：weekday 0=周一 … 6=周日，hour 0–23。 */
export interface StatsHeatCell {
  weekday: number
  hour: number
  value: number
}

/** 本地开发效率评分。 */
export interface StatsEfficiencyScore {
  score: number
  grade: 'excellent' | 'good' | 'fair' | 'low'
  codeGen: number
  problemSolve: number
  dialogQuality: number
  focus: number
  delta: StatsDelta
}

/** 完整统计快照。 */
export interface UsageStatsSnapshot {
  /** 查询范围起点（含）。 */
  rangeStart: number
  /** 查询范围终点（不含）。 */
  rangeEnd: number
  rangePreset: StatsRangePreset
  generatedAt: number
  /** 范围内是否有任何事件/轮次。 */
  hasData: boolean
  /**
   * SQLite 是否可用。false 时统计恒为空（实时面板仍可工作）。
   * 打包环境若 better-sqlite3 加载失败会落到此状态。
   */
  persistenceAvailable: boolean
  /** 本机库路径（便于排查 dev / 安装包 userData 是否同一文件）。 */
  dbPath?: string
  /** 打开数据库或聚合失败时的简短原因。 */
  persistenceError?: string
  kpis: StatsKpis
  tokenTrend: StatsTrendPoint[]
  durationTrend: StatsTrendPoint[]
  models: StatsModelShare[]
  projectRank: StatsProjectRank[]
  insights: StatsInsight[]
  projectTypes: StatsCategoryShare[]
  fileTypes: StatsCategoryShare[]
  dialogTokenBuckets: StatsDialogBucket[]
  heatmap: StatsHeatCell[]
  heatmapMax: number
  efficiency: StatsEfficiencyScore
}

/** IPC / 查询参数。 */
export interface UsageStatsQuery {
  range?: StatsRangePreset
  /** 可选覆盖起点（epoch ms）。 */
  start?: number
  /** 可选覆盖终点（epoch ms，不含）。 */
  end?: number
  /** 趋势粒度；默认 day。 */
  granularity?: StatsTrendGranularity
}
