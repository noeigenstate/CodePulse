import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TurnState } from '@codepulse/shared'
import {
  formatThinkingDepth,
  headerCopy,
  nextLocale,
  overallLabel,
  turnStateLabel,
  uiCopy,
} from '../apps/desktop/src/renderer/src/lib/i18n.js'
import { formatDuration, formatRelative } from '../apps/desktop/src/renderer/src/lib/format.js'
import {
  formatContextWindowStatus,
  formatProjectDirectoryBadge,
} from '../apps/desktop/src/renderer/src/lib/panelFormat.js'
import { formatQuotaReset } from '../apps/desktop/src/renderer/src/lib/quotaFormat.js'

test('header copy omits the old Chinese brand tag', () => {
  assert.equal(headerCopy('zh').brandTag, '')
  assert.equal(headerCopy('en').brandTag, '')
})

test('header copy does not expose a clear alerts action', () => {
  assert.equal('clearAlerts' in headerCopy('zh'), false)
  assert.equal('clearAlerts' in headerCopy('en'), false)
})

test('thinking depth is localized without deriving it from token usage', () => {
  assert.equal(uiCopy('zh').thinkingDepth, '思考深度')
  assert.equal(uiCopy('en').thinkingDepth, 'Thinking depth')
  assert.equal(formatThinkingDepth('ultra', 'zh'), '超高')
  assert.equal(formatThinkingDepth('max', 'en'), 'Max')
  assert.equal(formatThinkingDepth(undefined, 'zh'), '—')
  assert.equal(formatThinkingDepth('future-level', 'en'), 'future-level')
})

test('locale toggle switches between Chinese and English labels', () => {
  assert.equal(nextLocale('zh'), 'en')
  assert.equal(nextLocale('en'), 'zh')
  assert.equal(overallLabel('running', 'en'), 'Running')
  assert.equal(overallLabel('limited', 'en'), 'Usage limit')
  assert.equal(turnStateLabel(TurnState.USAGE_LIMITED, 'zh'), '已达用量上限，任务暂时停止')
  assert.equal(turnStateLabel(TurnState.DONE, 'en'), 'Done')
  assert.equal(turnStateLabel(TurnState.USAGE_LIMITED, 'en'), 'Usage limit reached, paused')
})

test('Chinese locale does not expose English dashboard chrome', () => {
  const copy = uiCopy('zh')
  const text = [
    headerCopy('zh').subtitle,
    headerCopy('zh').languageToggle,
    copy.contextWindow,
    copy.thinkingDepth,
    copy.waitingQuota,
    copy.unknownProject,
    copy.agentSetupReminder.title,
    copy.agentSetupReminder.body,
    copy.agentSetupReminder.firstRunNotice,
    copy.agentSetupReminder.cleanupNotice,
    copy.agentSetupReminder.missingCli,
    copy.agentSetupReminder.missingHook,
    copy.codexTrustTutorial.title,
    copy.codexTrustTutorial.body,
    copy.codexTrustTutorial.permissionsTitle,
    copy.codexTrustTutorial.permissions.join(' '),
    copy.codexTrustTutorial.steps.join(' '),
    copy.codexTrustTutorial.action,
    copy.updateAvailable.title,
    copy.updateAvailable.body,
    copy.updateAvailable.currentVersion,
    copy.updateAvailable.latestVersion,
    copy.updateAvailable.later,
    copy.updateAvailable.install,
    copy.updateAvailable.installing,
    copy.updateAvailable.failed,
    copy.settings.title,
    copy.settings.close,
    copy.settings.theme,
    copy.settings.themeLight,
    copy.settings.themeDark,
    copy.settings.cliTools,
    copy.settings.cliToolsHint,
    copy.emptyDashboard.settingsHiddenTitle,
    copy.emptyDashboard.settingsHiddenBody,
    formatContextWindowStatus(
      { accuracy: 'exact', contextUsedPercent: 79.85, contextWindow: 258_400, contextStale: true },
      undefined,
      copy.contextStatus,
    ).text,
    formatProjectDirectoryBadge(undefined, undefined, copy.pathStatus),
    formatDuration(62_000, 'zh'),
    formatRelative(1_000_000, 1_125_000, 'zh'),
    formatQuotaReset(1_000_005_400, 1_000_000_000_000, 'zh'),
  ].join(' ')

  assert.doesNotMatch(
    text,
    /\b(Context|window|left|used|last|waiting|project|directory|root|ago|refresh|Mute|Chinese)\b/i,
  )
})

test('English locale does not expose Chinese dashboard chrome', () => {
  const copy = uiCopy('en')
  const text = [
    headerCopy('en').subtitle,
    headerCopy('en').languageToggle,
    copy.contextWindow,
    copy.thinkingDepth,
    copy.waitingQuota,
    copy.unknownProject,
    copy.agentSetupReminder.title,
    copy.agentSetupReminder.body,
    copy.agentSetupReminder.firstRunNotice,
    copy.agentSetupReminder.cleanupNotice,
    copy.agentSetupReminder.missingCli,
    copy.agentSetupReminder.missingHook,
    copy.codexTrustTutorial.title,
    copy.codexTrustTutorial.body,
    copy.codexTrustTutorial.permissionsTitle,
    copy.codexTrustTutorial.permissions.join(' '),
    copy.codexTrustTutorial.steps.join(' '),
    copy.codexTrustTutorial.action,
    copy.updateAvailable.title,
    copy.updateAvailable.body,
    copy.updateAvailable.currentVersion,
    copy.updateAvailable.latestVersion,
    copy.updateAvailable.later,
    copy.updateAvailable.install,
    copy.updateAvailable.installing,
    copy.updateAvailable.failed,
    copy.settings.title,
    copy.settings.close,
    copy.settings.theme,
    copy.settings.themeLight,
    copy.settings.themeDark,
    copy.settings.cliTools,
    copy.settings.cliToolsHint,
    copy.emptyDashboard.settingsHiddenTitle,
    copy.emptyDashboard.settingsHiddenBody,
    formatContextWindowStatus(
      { accuracy: 'exact', contextUsedPercent: 79.85, contextWindow: 258_400, contextStale: true },
      undefined,
      copy.contextStatus,
    ).text,
    formatProjectDirectoryBadge(undefined, undefined, copy.pathStatus),
    formatDuration(62_000, 'en'),
    formatRelative(1_000_000, 1_125_000, 'en'),
    formatQuotaReset(1_000_005_400, 1_000_000_000_000, 'en'),
  ].join(' ')

  assert.doesNotMatch(text, /[\u4e00-\u9fff]/)
})

test('setup tutorial explains written config, uninstall cleanup, and Codex hook permissions', () => {
  const zh = uiCopy('zh')
  assert.match(zh.agentSetupReminder.firstRunNotice, /~\/\.claude\/settings\.json/)
  assert.match(zh.agentSetupReminder.firstRunNotice, /~\/\.codex\/hooks\.json/)
  assert.match(zh.agentSetupReminder.firstRunNotice, /~\/\.codex\/config\.toml/)
  assert.match(zh.agentSetupReminder.firstRunNotice, /~\/\.grok\/hooks\/codepulse\.json/)
  assert.match(zh.agentSetupReminder.cleanupNotice, /卸载/)
  assert.match(zh.agentSetupReminder.cleanupNotice, /自动删除/)
  assert.match(zh.codexTrustTutorial.permissions.join(' '), /SessionStart/)
  assert.match(zh.codexTrustTutorial.permissions.join(' '), /PermissionRequest/)
  assert.match(zh.codexTrustTutorial.permissions.join(' '), /Stop/)

  const en = uiCopy('en')
  assert.match(en.agentSetupReminder.firstRunNotice, /~\/\.claude\/settings\.json/)
  assert.match(en.agentSetupReminder.firstRunNotice, /~\/\.grok\/hooks\/codepulse\.json/)
  assert.match(en.agentSetupReminder.cleanupNotice, /uninstalled/)
  assert.match(en.codexTrustTutorial.permissions.join(' '), /SessionStart/)
  assert.match(en.codexTrustTutorial.permissions.join(' '), /PermissionRequest/)
  assert.match(en.codexTrustTutorial.permissions.join(' '), /Stop/)
})

test('Codex trust tutorial uses user-facing hook selection steps', () => {
  const zhSteps = uiCopy('zh').codexTrustTutorial.steps.join(' ')
  const enSteps = uiCopy('en').codexTrustTutorial.steps.join(' ')

  assert.doesNotMatch(zhSteps, /codepulse-hooks\/bin\/codex-hook\.js/)
  assert.doesNotMatch(enSteps, /codepulse-hooks\/bin\/codex-hook\.js/)
  assert.match(zhSteps, /CodePulse hook/)
  assert.match(enSteps, /Select the CodePulse hook/)
})

test('setup tutorial modal keeps long instructions scrollable', () => {
  const appSource = readFileSync('apps/desktop/src/renderer/src/App.tsx', 'utf8')

  assert.match(appSource, /max-h-\[min\(calc\(100vh-2rem\),42rem\)\]/)
  assert.match(appSource, /overflow-y-auto/)
  assert.match(appSource, /shrink-0 border-t/)
})

test('settings dialog traps keyboard focus and returns it to the invoking control', () => {
  const settingsSource = readFileSync(
    'apps/desktop/src/renderer/src/components/SettingsDialog.tsx',
    'utf8',
  )

  assert.match(settingsSource, /closeButtonRef\.current\?\.focus\(\)/)
  assert.match(settingsSource, /previouslyFocused\?\.focus\(\)/)
  assert.match(settingsSource, /FOCUSABLE_SELECTOR/)
  assert.match(settingsSource, /event\.key !== 'Tab'/)
})

test('reduced transparency keeps the selected theme surface instead of forcing white', () => {
  const styles = readFileSync('apps/desktop/src/renderer/src/index.css', 'utf8')
  const reducedTransparency = styles.match(
    /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/,
  )?.[1]

  assert.ok(reducedTransparency)
  assert.match(reducedTransparency, /background: var\(--surface-solid\)/)
  assert.doesNotMatch(reducedTransparency, /background: #ffffff/)
})
