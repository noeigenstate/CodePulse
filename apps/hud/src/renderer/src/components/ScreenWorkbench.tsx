import { useEffect, useRef, useState } from 'react'
import type {
  DeviceDisplaySnapshot,
  DeviceProvisioningSnapshot,
  WorkbenchWindowState,
} from '@codepulse/shared'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import { DeviceDisplayPanel } from './DeviceDisplayPanel.js'
import { DeviceProvisioningPanel } from './DeviceProvisioningPanel.js'
import { AmbientPanel } from './AmbientPanel.js'
import type { DeviceProvisioningCopy } from '../lib/i18n.js'
import './product-shell.css'

/** Coalesce source events into one read; rendering never starts another collector. */
export function useScreenTarget(active = true) {
  const [target, setTarget] = useState<DeviceDisplaySnapshot>()
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!active) return
    let alive = true,
      busy = false,
      again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        const next = await window.codepulse.getDeviceDisplay()
        if (alive) {
          setTarget(next)
          setError(false)
        }
      } catch {
        if (alive) setError(true)
      } finally {
        busy = false
        if (alive && again) {
          again = false
          schedule()
        }
      }
    }
    const schedule = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void read()
        }, 160)
    }
    const stops = [
      window.codepulse.onStatus(schedule),
      window.codepulse.onAmbient(schedule),
      window.codepulse.onDeviceDisplay(schedule),
    ]
    void read()
    const heartbeat = setInterval(schedule, 30000)
    return () => {
      alive = false
      stops.forEach((stop) => stop())
      clearInterval(heartbeat)
      clearTimeout(timer)
    }
  }, [active])
  return { target, error }
}

export function ScreenWorkbench({
  copy,
  standalone = false,
  active = true,
}: {
  copy: DeviceProvisioningCopy
  standalone?: boolean
  active?: boolean
}): JSX.Element {
  const { target, error } = useScreenTarget(active)
  const [device, setDevice] = useState<DeviceProvisioningSnapshot>()
  const [section, setSection] = useState('screen')
  const [visited, setVisited] = useState(new Set(['screen']))
  const [presentation, setPresentation] = useState(false)
  const [windowState, setWindowState] = useState<WorkbenchWindowState>({
    pinned: false,
    fullscreen: false,
  })
  const [message, setMessage] = useState('')
  const latestWindowState = useRef(windowState)
  latestWindowState.current = windowState
  useEffect(() => {
    let alive = true,
      received = false
    const stop = window.codepulse.onDeviceProvisioning((s) => {
      received = true
      if (alive) setDevice(s)
    })
    void window.codepulse
      .getDeviceProvisioning()
      .then((s) => {
        if (alive && !received) setDevice(s)
      })
      .catch(() => {})
    let windowReceived = false
    const offWindow = window.codepulse.onWorkbenchWindow((s) => {
      windowReceived = true
      if (alive) setWindowState(s)
    })
    if (standalone) void window.codepulse.setWorkbenchWindow({}).then(s => {
      if (alive && !windowReceived) setWindowState(s)
    }).catch(() => {})
    return () => {
      alive = false
      stop()
      offWindow()
    }
  }, [standalone])
  const show = (value: string) => {
    setSection(value)
    setVisited((old) => new Set([...old, value]))
  }
  const toggleWindow = async (key: keyof WorkbenchWindowState) => {
    try {
      const requested = !latestWindowState.current[key]
      const next = await window.codepulse.setWorkbenchWindow({ [key]: requested })
      setWindowState(next)
      setMessage(key === 'pinned' && next.pinned !== requested ? '系统未应用置顶设置，可稍后重试。' : '')
    } catch {
      setMessage('独立窗口暂不可用，请重新打开屏幕工作台。')
    }
  }
  const mode = target?.status.ambient
    ? '桌边动态'
    : target?.config.mode === 'usage'
      ? '用量看板'
      : '工作状态'
  return (
    <div className={`screen-workbench ${presentation ? 'is-presenting' : ''}`}>
      <header className="workspace-heading">
        <div>
          <span className="product-eyebrow">CODEPULSE / SCREEN</span>
          <h1>屏幕工作台</h1>
          <p>一份内容，在桌面与墨水屏上呈现。</p>
        </div>
        <div className="workspace-actions">
          {standalone ? (
            <>
              <button
                type="button"
                aria-pressed={windowState.pinned}
                onClick={() => void toggleWindow('pinned')}
              >
                {windowState.pinned ? '已置顶' : '置顶'}
              </button>
              <button
                type="button"
                aria-pressed={windowState.fullscreen}
                onClick={() => void toggleWindow('fullscreen')}
              >
                {windowState.fullscreen ? '退出全屏' : '全屏'}
              </button>
              <button
                type="button"
                onClick={() =>
                  void window.codepulse
                    .openSurface('standard')
                    .catch(() => setMessage('标准客户端暂不可用。'))
                }
              >
                打开客户端 ↗
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() =>
                void window.codepulse
                  .openSurface('screen')
                  .catch(() => setMessage('独立窗口暂不可用。'))
              }
            >
              独立打开 ↗
            </button>
          )}
          <button
            type="button"
            aria-pressed={presentation}
            onClick={() => {
              setPresentation((v) => !v)
              show('screen')
            }}
          >
            {presentation ? '退出展示' : '专注展示'}
          </button>
        </div>
      </header>
      {message && <p role="status">{message}</p>}
      {!presentation && (
        <nav className="workspace-tabs" aria-label="屏幕工作台栏目">
          {[
            ['screen', '当前画面'],
            ['layout', '显示配置'],
            ['ambient', '动态规则'],
            ['device', '设备连接'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => show(id!)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      <section hidden={section !== 'screen'} className="screen-live">
        <div className="screen-context">
          <span className="live-dot" />
          当前目标 · {mode}
          <span>{target?.serverAvailable ? '设备服务已开启' : '桌面显示可用'}</span>
        </div>
        {target ? (
          <DeviceScreenPreview status={target.status} live />
        ) : (
          <p className="product-empty" role="status">
            {error ? '画面暂时不可用，正在等待桌面服务。' : '正在读取当前画面…'}
          </p>
        )}
        {target && error && <p role="status">连接暂时中断，当前显示最后收到的目标画面。</p>}
        {!presentation && (
          <div className="screen-notes">
            <p>
              <strong>桌面与墨水屏共用画面</strong>
              <br />
              工作提醒优先；空闲时，符合规则的 X 贴文或 meme 会自动出现。
            </p>
            <p>
              <strong>
                {device?.displays.length
                  ? `发现 ${device.displays.length} 台设备`
                  : '尚未发现实体设备'}
              </strong>
              <br />
              这里是电脑准备发送的画面，实体屏是否完成刷新尚无回执。没有设备也可使用桌面展示。
            </p>
          </div>
        )}
      </section>
      {visited.has('layout') && (
        <section hidden={section !== 'layout'}>
          <DeviceDisplayPanel active={active && section === 'layout'} />
        </section>
      )}
      {visited.has('ambient') && (
        <section hidden={section !== 'ambient'}>
          <AmbientPanel />
        </section>
      )}
      {visited.has('device') && (
        <section hidden={section !== 'device'}>
          <DeviceProvisioningPanel copy={copy} />
        </section>
      )}
    </div>
  )
}
