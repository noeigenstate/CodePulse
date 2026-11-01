import { hudProviderRank, normalizeDeviceDisplay, type DeviceDisplayConfig, type DeviceStatusV1 } from '@codepulse/shared'

export type DevicePreviewSource = 'live' | 3 | 6 | 9

// Renderer-only examples. Never ingest these into StatusHub, IPC or device API.
const TITLES = [
  'CodePulse · 墨水屏同步与任务标题校验',
  '示例项目 · 海面模拟效果验证',
  '固件 · 长标题与待确认状态',
  '登录流程 · 会话过期后的恢复',
  '项目索引 · 多工作区名称同步',
  '发布检查 · 配置迁移与回归验证',
  '设备联网 · 断线重连和地址更新',
  '桌面预览 · 九任务布局检查',
  '长标题压力测试 abcdefghijklmnopqrstuvwxyz',
] as const
const STATES = ['waiting_permission', 'thinking', 'done'] as const

export function createDeviceDensityPreview(config: DeviceDisplayConfig, count: 3 | 6 | 9): DeviceStatusV1 {
  const display = { ...normalizeDeviceDisplay(config), page: 0 }
  const providers = [...display.agents].sort((a,b) => hudProviderRank(a) - hudProviderRank(b))
  const threads = providers.length ? Array.from({ length: count }, (_, index) => ({
    id: (index + 1).toString(16).padStart(24, '0'),
    type: providers[Math.min(providers.length - 1, Math.floor(index * providers.length / count))]!,
    title: TITLES[index]!,
    detail: index % 3 === 0 ? '运行测试需要你的确认' : index % 3 === 1 ? '正在检查显示区域与状态映射' : '本轮任务已完成',
    state: STATES[index % STATES.length]!,
  })) : []
  return {
    protocolVersion: 1, revision: `preview-density-${count}`, mainState: 'waiting_permission',
    activeAgent: providers[0] ?? null, message: '示例画面', updatedAt: 0,
    display, threads, threadTotal: threads.length,
    agents: providers.map((type, index) => ({
      type, state: 'thinking', project: null, model: null, activity: null,
      needsAttention: false, updatedAt: 0,
      tokens: { input: null, cachedInput: null, output: null, reasoningOutput: null,
        total: null, contextUsedPercent: null, contextWindow: null, contextStale: false,
        contextCompressed: false, accuracy: 'unknown' },
      quotas: [{ id: type, name: null, fiveHour: null,
        weekly: { usedPercent: index ? 9 : 53, resetsAt: null, windowMinutes: 10080 } }],
    })),
  }
}
