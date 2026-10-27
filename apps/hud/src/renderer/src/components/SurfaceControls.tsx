import { useEffect, useState } from 'react'
import type { ShellSnapshot } from '@codepulse/shared'
import './surface-controls.css'

export function SurfaceControls({
  compact = false,
  locale = 'zh',
}: {
  compact?: boolean
  locale?: string
}): JSX.Element {
  const [shell, setShell] = useState<ShellSnapshot>()
  const [error, setError] = useState('')
  const zh = locale === 'zh'
  useEffect(() => {
    let alive = true,
      received = false
    const stop = window.codepulse.onShell((s) => {
      received = true
      if (alive) setShell(s)
    })
    void window.codepulse
      .getShell()
      .then((s) => {
        if (alive && !received) setShell(s)
      })
      .catch(() => {})
    return () => {
      alive = false
      stop()
    }
  }, [])
  const act = (run: () => Promise<unknown>) => {
    setError('')
    void run().catch(() =>
      setError(zh ? '请通过统一桌面启动 CodePulse' : 'Start the unified CodePulse host'),
    )
  }
  return (
    <div className={`surface-controls ${compact ? 'is-compact' : ''}`}>
      {compact ? (
        <>
          <button
            type="button"
            title={zh ? '打开控制台，保持 HUD' : 'Open console alongside HUD'}
            onClick={() => act(() => window.codepulse.openSurface('standard', 'control'))}
          >
            {zh ? '标准' : 'App'}
          </button>
          <button
            type="button"
            title={zh ? '独立屏幕工作台' : 'Screen workbench'}
            onClick={() => act(() => window.codepulse.openSurface('screen'))}
          >
            {zh ? '屏幕' : 'Screen'}
          </button>
          <button
            type="button"
            title={zh ? 'HUD 设置' : 'HUD settings'}
            onClick={() => act(() => window.codepulse.openSettingsWindow())}
          >
            ⚙
          </button>
        </>
      ) : (
        <>
          <div
            className="surface-switch"
            role="group"
            aria-label={zh ? '打开窗口' : 'Open a window'}
          >
            <button
              type="button"
              onClick={() => act(() => window.codepulse.openSurface('standard', 'control'))}
            >
              {zh ? '标准客户端' : 'Standard'}
            </button>
            <button
              type="button"
              disabled={!shell?.hudAvailable}
              onClick={() => act(() => window.codepulse.openSurface('hud'))}
            >
              HUD
            </button>
          </div>
          <button
            type="button"
            title={zh ? '保持当前窗口，额外打开屏幕工作台' : 'Open a separate screen window'}
            onClick={() => act(() => window.codepulse.openSurface('screen'))}
          >
            {zh ? '独立屏幕 ↗' : 'Screen ↗'}
          </button>
        </>
      )}
      {error && (
        <span role="status" className="surface-error">
          {error}
        </span>
      )}
    </div>
  )
}
