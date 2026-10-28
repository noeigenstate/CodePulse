import { useEffect, useRef, useState } from 'react'
import type { DeviceStatusV1 } from '@codepulse/shared'
import { createDeviceRenderer, frameToRgba } from '../device-preview/renderer.mjs'
import manifest from '../device-preview/manifest.json'

let renderer: ReturnType<typeof createDeviceRenderer> | undefined
function loadRenderer(): ReturnType<typeof createDeviceRenderer> {
  if (!renderer) {
    // Embedded bytes also work in packaged Electron's file:// renderer. The
    // large payload is a lazy chunk and needs no network or file fetch API.
    renderer = import('../device-preview/renderer.b64?raw').then(({ default: encoded }) => {
      return createDeviceRenderer(Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0)))
    }).catch(error => { renderer = undefined; throw error })
  }
  return renderer
}

export function DeviceScreenPreview({ status, sample = false, live = false }: { status: DeviceStatusV1; sample?: boolean; live?: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [zoom, setZoom] = useState(1)
  const [retry, setRetry] = useState(0)
  const hasFrame = useRef(false)
  useEffect(() => {
    let alive = true
    if (!hasFrame.current) setState('loading')
    void loadRenderer().then(render => {
      if (!alive) return
      const context = canvas.current?.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      const image = context.createImageData(400, 300)
      image.data.set(frameToRgba(render(status)))
      context.putImageData(image, 0, 0)
      hasFrame.current = true
      setState('ready')
    }).catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [status, retry])
  const description = status.ambient ? `桌边动态，${status.ambient.source}：${status.ambient.text}` : status.display?.mode === 'usage'
    ? `用量看板，${status.display.agents.length} 个账号`
    : `HUD 工作，${status.threads?.length ?? 0} 个线程。${(status.threads ?? []).map(t => t.title).join('；')}`
  return <div className="device-preview" data-render-state={state}>
    <div className="device-preview-toolbar"><span>{live ? '当前目标画面' : status.ambient ? '内容预览' : sample ? '样例画面' : '最新任务画面'} · 400 × 300</span><div>{[1, 2].map(value => <button key={value} type="button" aria-pressed={zoom === value} onClick={() => setZoom(value)}>{value === 1 ? '实际像素' : '2 倍检查'}</button>)}</div></div>
    <div className="device-preview-scroll" aria-busy={state === 'loading'}>
      <div className="device-preview-frame" style={{ width: 400 * zoom + 24 }}>
        <canvas ref={canvas} width={400} height={300} className="device-screen" style={{ width: 400 * zoom, height: 300 * zoom, visibility: state === 'error' ? 'hidden' : 'visible' }} role="img" aria-label={description}>{description}</canvas>
      </div>
    </div>
    <div className="device-preview-note" aria-live="polite">{state === 'error' ? <><span>预览暂时无法生成。</span><button type="button" onClick={() => setRetry(n => n + 1)}>重试预览</button></> : state === 'loading' ? '正在生成画面…' : live ? '随工作状态与展示规则自动更新。' : sample ? '仅在桌面演示，不会更改设备内容或配置。' : `画面版本 ${manifest.firmwareVersion} · 调整后即时预览，点击「应用配置」才保存。`}</div>
    <p className="device-preview-note">{live ? '实体屏的温湿度、电量和刷新回执尚未回传；未知读数不会替换为模拟数据。' : '温湿度、电量和联网标记暂未回传，预览显示未知／未连接。这里展示目标画面，不代表实机已经刷新，也不模拟闪烁与残影。'}</p>
  </div>
}
