import { buildWorkPresentation } from '@codepulse/shared'
import { useMemo, type CSSProperties } from 'react'
import { DEFAULT_HUD_SETTINGS, type AgentRuntimeState, type HudAppearanceSettings, type HudToolKey, type StatusSnapshot } from '@codepulse/shared'
import { ProjectDeck } from './ProjectDeck.js'
import { resolveTheme } from '../lib/dashboardSettings.js'
import { uiCopy, type Locale } from '../lib/i18n.js'
import './project-deck-preview.css'

const ignore = () => {}
// The unified host supports providers beyond this HUD build. Narrow at the
// presentation boundary instead of changing either checkout's provider model.
type PreviewAgent = Omit<AgentRuntimeState, 'agentType'> & { agentType: string }
type PreviewSnapshot = Omit<StatusSnapshot, 'agents'> & { agents: readonly PreviewAgent[] }
function supportedAgent(agent: PreviewAgent): agent is AgentRuntimeState & { agentType: HudToolKey } {
  return agent.agentType === 'codex' || agent.agentType === 'claude_code' ||
    agent.agentType === 'grok' || agent.agentType === 'kimi' || agent.agentType === 'antigravity'
}
/** Read-only view of the production HUD; no native window, acknowledgement or dismissal. */
export function HudPreview({
  snapshot,
  locale,
  settings = DEFAULT_HUD_SETTINGS,
}: {
  snapshot: PreviewSnapshot
  locale: Locale
  settings?: HudAppearanceSettings
}): JSX.Element {
  const visibleAgents = useMemo(
    () =>
      snapshot.agents.filter(
        (agent): agent is AgentRuntimeState =>
          supportedAgent(agent) && settings.visibleTools[agent.agentType] !== false,
      ),
    [snapshot.agents, settings.visibleTools],
  )
  const panels = useMemo(() => buildWorkPresentation({ ...snapshot, agents: visibleAgents }).panels, [visibleAgents, snapshot.workOrder])
  const allToolsHidden = useMemo(
    () => Object.values(settings.visibleTools).every((visible) => !visible),
    [settings.visibleTools],
  )
  const copy = useMemo(() => uiCopy(locale), [locale])
  const resolvedTheme = resolveTheme(settings.theme)
  const previewStyle = {
    '--hud-opacity': String(settings.hudOpacity / 100),
  } as CSSProperties
  return (
    <fieldset
      disabled
      className="hud-preview"
      data-theme={resolvedTheme}
      data-attention-effect={settings.attentionEffect}
      style={previewStyle}
      aria-label={locale === 'zh' ? 'HUD 实时预览' : 'Live HUD preview'}
    >
      <ProjectDeck
        preview
        allToolsHidden={allToolsHidden}
        copy={copy}
        locale={locale}
        layout={settings.projectLayout}
        panels={panels}
        showUsageStrip={settings.showUsageStrip}
        onAck={ignore}
        onDismiss={ignore}
      />
    </fieldset>
  )
}
