import { useEffect, useState } from 'react'
import type {
  UiLocale,
  WorkVoiceTarget,
  WorkVoiceSettings,
  WorkVoiceTargetsSnapshot,
} from '@codepulse/shared'

export function WorkVoiceSettingsPanel({
  locale,
  target,
  active = true,
}: {
  locale: UiLocale
  target: WorkVoiceTarget
  active?: boolean
}): JSX.Element {
  const zh = locale === 'zh',
    ink = target === 'ink'
  const [all, setAll] = useState<WorkVoiceTargetsSnapshot>()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!active) return
    let alive = true
    const accept = (value: WorkVoiceTargetsSnapshot) => {
      if (alive) setAll(value)
    }
    const read = () => {
      void window.codepulse
        .getWorkVoice()
        .then(accept)
        .catch(() => {
          if (alive) setFailed(true)
        })
    }
    read()
    const stop = window.codepulse.onWorkVoice(accept)
    const timer = ink ? setInterval(read, 5000) : undefined
    return () => {
      alive = false
      stop()
      clearInterval(timer)
    }
  }, [active, ink])
  const state = all?.[target]
  const change = async (patch: Partial<WorkVoiceSettings>): Promise<void> => {
    if (!state) return
    setSaving(true)
    setFailed(false)
    try {
      setAll(await window.codepulse.setWorkVoice(target, { ...state.settings, ...patch }))
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const preview = async (): Promise<void> => {
    setFailed(false)
    try {
      setAll(await window.codepulse.testWorkVoice(target, locale))
    } catch {
      setFailed(true)
    }
  }
  const stop = async (): Promise<void> => {
    try {
      setAll(await window.codepulse.stopWorkVoice(target))
    } catch {
      setFailed(true)
    }
  }
  const disabled = !state || saving
  const ready = Boolean(state?.supported && (!ink || all?.ink.deviceAvailable))
  return (
    <section
      className="work-voice-options"
      aria-label={
        zh
          ? ink
            ? '墨水屏设备语音提醒'
            : '主窗口语音提醒'
          : ink
            ? 'E-paper device voice alerts'
            : 'Window voice alerts'
      }
    >
      <details className="work-voice-details">
        <summary>
          <span>{zh ? '语音提醒' : 'Voice alerts'}</span>
          <small aria-live="polite" data-enabled={Boolean(state?.settings.enabled)}>
            {failed || state?.error
              ? zh
                ? '需检查'
                : 'Check'
              : !state
                ? zh
                  ? '读取中'
                  : 'Loading'
                : state.speaking
                  ? zh
                    ? '播报中'
                    : 'Speaking'
                  : state.settings.enabled
                    ? zh
                      ? '已开启'
                      : 'On'
                    : zh
                      ? '已关闭'
                      : 'Off'}
          </small>
        </summary>
        <div className="work-voice-content">
          <p className="product-caption">
            {ink
              ? zh
                ? '从墨水屏扬声器播报。配置可先保存，音频固件与硬件就绪后生效。'
                : 'Play through the e-paper speaker. Preferences can be saved before audio hardware and firmware are ready.'
              : zh
                ? '从电脑扬声器播报，主窗口与悬浮窗 共用一次提醒。'
                : 'Play through this computer. The window and overlay share one alert.'}
          </p>
          <div className="grid gap-2 text-sm">
            <label className="hud-inline-check">
              <input
                type="checkbox"
                disabled={disabled}
                checked={state?.settings.enabled ?? false}
                onChange={(e) => void change({ enabled: e.target.checked })}
              />
              {zh ? '开启此端语音提醒' : 'Enable voice on this output'}
            </label>
            <label className="hud-inline-check">
              <input
                type="checkbox"
                disabled={disabled || !state?.settings.enabled}
                checked={state?.settings.intervention ?? true}
                onChange={(e) => void change({ intervention: e.target.checked })}
              />
              {zh
                ? '需要介入：授权或回答问题'
                : 'Intervention: approve an action or answer a question'}
            </label>
            <label className="hud-inline-check">
              <input
                type="checkbox"
                disabled={disabled || !state?.settings.enabled}
                checked={state?.settings.failures ?? true}
                onChange={(e) => void change({ failures: e.target.checked })}
              />
              {zh
                ? '异常：失败、疑似卡住、额度受限'
                : 'Problems: failed, possibly stuck or usage limited'}
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                className="product-button"
                disabled={disabled || !ready || state?.speaking}
                type="button"
                onClick={() => void preview()}
              >
                {zh ? '试听语音' : 'Preview voice'}
              </button>
              <button
                className="product-button"
                disabled={disabled}
                type="button"
                onClick={() => void stop()}
              >
                {ink
                  ? zh
                    ? '取消待播'
                    : 'Cancel pending alerts'
                  : zh
                    ? '停止播报'
                    : 'Stop speaking'}
              </button>
            </div>
          </div>
          <p className="product-caption">
            {zh
              ? '单独保存，即时生效。两端独立开关；稳定 2 秒、合并提醒、至少间隔 60 秒，不反复催促。'
              : 'Saved immediately. Outputs are independent: settle for 2 seconds, batch alerts and stay at least 60 seconds apart.'}
          </p>
          <p className="product-caption">
            {zh
              ? '每次等待过程提醒一次；恢复工作后的新请求可以再提醒。已解决取消，旧任务不补播。'
              : 'Each waiting episode alerts once. A new request after work resumes can alert again; resolved and historical alerts are skipped.'}
          </p>
          <p className="product-caption" role="status" aria-live="polite">
            {failed
              ? zh
                ? '操作失败，请重试。'
                : 'Operation failed. Please retry.'
              : state?.error
                ? zh
                  ? '语音不可用，请检查本机语音包与输出设备。'
                  : 'Speech unavailable. Check host voices and audio output.'
                : !state?.supported && state
                  ? zh
                    ? '当前主机暂不支持本地语音合成。'
                    : 'Local speech synthesis is not supported on this host.'
                  : ink && !ready
                    ? zh
                      ? '待音频固件接入；当前设备不具备已验证的扬声器能力。'
                      : 'Waiting for audio-capable firmware. Device speaker capability has not been verified.'
                    : state?.speaking
                      ? zh
                        ? '正在处理语音…'
                        : 'Processing speech…'
                      : ''}
          </p>
        </div>
      </details>
    </section>
  )
}
