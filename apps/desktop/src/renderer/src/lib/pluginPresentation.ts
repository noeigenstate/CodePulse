import { pluginGlyph, type AmbientCard, type ClientInstalledPlugin } from '@codepulse/shared'

export interface PluginRow {
  id: string
  name: string
  source: string
  enabled: boolean | null
  disabled?: boolean
  state: string
  reason?: string
  count: string
  glyph?: string
  logo?: string | null
  install?: ClientInstalledPlugin
}

/** Logos are platform paths. Invalid metadata must not break the installed list or load another origin. */
export function platformLogo(origin: string, path: string | null): string | null {
  if (!origin || !path) return null
  try {
    const base = new URL(origin)
    const logo = new URL(path, base)
    return /^https?:$/.test(logo.protocol) && logo.origin === base.origin ? logo.href : null
  } catch {
    return null
  }
}

export function cloudPluginRows(
  installs: ClientInstalledPlugin[],
  origin: string,
  cards: AmbientCard[],
): PluginRow[] {
  return installs.map((install) => ({
    id: install.pluginId,
    name: install.plugin?.name ?? install.pluginId,
    source: `平台 · ${install.plugin?.developer ?? '已下架'}`,
    enabled: install.enabled,
    glyph: pluginGlyph(install.plugin?.name ?? install.pluginId),
    install,
    state: !install.enabled
      ? '已关闭'
      : !install.plugin
        ? '需要设置'
        : install.status.error
          ? needsPluginSetup(install.status.error)
            ? '需要设置'
            : '生成失败'
          : '正常',
    reason:
      (install.enabled && install.status.error) || (!install.plugin ? '插件已下架，可卸载' : ''),
    count: `${cards.filter((card) => card.kind === 'plugin' && card.plugin?.id === install.pluginId).length} 张`,
    logo: platformLogo(origin, install.plugin?.logoUrl ?? null),
  }))
}

export interface CloudPluginsState {
  state: 'unregistered' | 'offline' | 'ok'
  platformOrigin: string
  plugins: ClientInstalledPlugin[]
}

export function retainCloudPlugins(
  previous: CloudPluginsState | undefined,
  next: CloudPluginsState,
): CloudPluginsState {
  if (next.state !== 'offline' || !previous) return next
  return {
    ...next,
    platformOrigin: next.platformOrigin || previous.platformOrigin,
    plugins: previous.plugins,
  }
}

export function needsPluginSetup(error: string): boolean {
  return /密钥|api[ _-]?key|未配置|需要设置/i.test(error)
}

export function pluginPreviewCard(
  cards: AmbientCard[],
  pluginId: string,
  activeId?: string | null,
): AmbientCard | undefined {
  const matches = cards.filter((card) => card.kind === 'plugin' && card.plugin?.id === pluginId)
  return matches.find((card) => card.id === activeId) ?? matches[0]
}
