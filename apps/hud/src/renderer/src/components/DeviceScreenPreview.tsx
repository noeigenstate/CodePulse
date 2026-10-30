import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { deviceInspectScale, devicePixelRatioLabel, devicePreviewScale, type DeviceStatusV1 } from '@codepulse/shared'
import { createDevicePlaneRenderer, planesToRgba } from '../device-preview/renderer.mjs'
import manifest from '../device-preview/manifest.json'

let renderer: ReturnType<typeof createDevicePlaneRenderer> | undefined
function loadRenderer(): ReturnType<typeof createDevicePlaneRenderer> {
  if (!renderer) {
    // Embedded bytes also work in packaged Electron's file:// renderer. The
    // large payload is a lazy chunk and needs no network or file fetch API.
    renderer = import('../device-preview/renderer.b64?raw').then(({ default: encoded }) => {
      return createDevicePlaneRenderer(Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0)))
    }).catch(error => { renderer = undefined; throw error })
  }
  return renderer
}

/** Device pixel ratio of the window the preview is on; follows zoom and moves between monitors. */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    let query: MediaQueryList | undefined
    const update = () => {
      query?.removeEventListener('change', update)
      setDpr(window.devicePixelRatio || 1)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      query.addEventListener('change', update)
    }
    update()
    window.addEventListener('resize', update)
    return () => { query?.removeEventListener('change', update); window.removeEventListener('resize', update) }
  }, [])
  return dpr
}

/** Width the canvas may use (the scroll area minus the frame's padding and border), and whether the workbench is presenting. */
function useAvailableWidth(scroll: RefObject<HTMLElement>, frame: RefObject<HTMLElement>): { width: number; presenting: boolean } {
  const [available, setAvailable] = useState({ width: Infinity, presenting: false })
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const measure = () => {
      const style = frame.current ? getComputedStyle(frame.current) : undefined
      const chrome = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) : 0
      setAvailable({ width: Math.max(0, element.clientWidth - (chrome || 0)), presenting: Boolean(element.closest('.is-presenting')) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scroll, frame])
  return available
}

/**
 * Nudge the frame so the canvas starts on a physical pixel. At a fractional phase the 400k-pixel
 * canvas paints as 400k-1 or 400k+1 pixels wide and 1-pixel strokes turn uneven. Layout units are 1/64 CSS px,
 * so "on a pixel" means within 0.03 physical pixels.
 */
function useWholePixelAlign(canvas: RefObject<HTMLElement>, frame: RefObject<HTMLElement>, scroll: RefObject<HTMLElement>, dpr: number): void {
  const offset = useRef({ x: 0, y: 0 })
  const align = () => {
    const box = frame.current
    if (!box || !canvas.current) return
    const rect = canvas.current.getBoundingClientRect()
    const phase = (value: number) => (value * dpr - Math.round(value * dpr)) / dpr
    const dx = phase(rect.left), dy = phase(rect.top)
    if (Math.abs(dx * dpr) < 0.03 && Math.abs(dy * dpr) < 0.03) return
    offset.current = { x: offset.current.x - dx, y: offset.current.y - dy }
    // A layout offset, not a transform: layout snaps the canvas to whole physical pixels, while a
    // fractional transform is applied after snapping and resamples every edge row and column.
    box.style.position = 'relative'
    box.style.left = `${offset.current.x}px`
    box.style.top = `${offset.current.y}px`
  }
  useLayoutEffect(align)
  useEffect(() => {
    const element = scroll.current
    const observer = new ResizeObserver(align)
    if (element) observer.observe(element)
    window.addEventListener('resize', align)
    return () => { observer.disconnect(); window.removeEventListener('resize', align) }
  }, [scroll, dpr])
}

export function DeviceScreenPreview({ status, sample = false, live = false }: { status: DeviceStatusV1; sample?: boolean; live?: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [zoom, setZoom] = useState(1)
  const [retry, setRetry] = useState(0)
  const hasFrame = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const dpr = useDevicePixelRatio()
  const { width, presenting } = useAvailableWidth(scroll, frame)
  useWholePixelAlign(canvas, frame, scroll, dpr)
  const scale = zoom === 1 ? devicePreviewScale(dpr, width, presenting) : deviceInspectScale(dpr)
  useEffect(() => {
    let alive = true
    if (!hasFrame.current) setState('loading')
    void loadRenderer().then(render => {
      if (!alive) return
      const context = canvas.current?.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      const image = context.createImageData(400, 300)
      const { black, red } = render(status)
      image.data.set(planesToRgba(black, red))
      context.putImageData(image, 0, 0)
      hasFrame.current = true
      setState('ready')
    }).catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [status, retry])
  const description = status.ambient ? `桌边动态，${status.ambient.source}：${status.ambient.text}` : status.display?.mode === 'usage'
    ? `用量看板，${status.display.agents.length} 个账号`
    : `HUD 工作，${status.threads?.length ?? 0} 个线程。${(status.threads ?? []).map(t => t.title).join('；')}`
  return <div className="device-preview" data-render-state={state} data-pixel-ratio={scale.k}>
    <div className="device-preview-toolbar"><span>{live ? '当前目标画面' : status.ambient ? '内容预览' : sample ? '样例画面' : '最新任务画面'} · 400 × 300 · {devicePixelRatioLabel(scale.k)}</span><div>{[1, 2].map(value => <button key={value} type="button" aria-pressed={zoom === value} onClick={() => setZoom(value)}>{value === 1 ? '实际像素' : '2 倍检查'}</button>)}</div></div>
    <div ref={scroll} className="device-preview-scroll" aria-busy={state === 'loading'}>
      <div ref={frame} className="device-preview-frame" style={{ width: scale.cssWidth }}>
        <canvas ref={canvas} width={400} height={300} className="device-screen" style={{ width: scale.cssWidth, height: scale.cssHeight, visibility: state === 'error' ? 'hidden' : 'visible' }} role="img" aria-label={description}>{description}</canvas>
      </div>
    </div>
    <div className="device-preview-note" aria-live="polite">{state === 'error' ? <><span>预览暂时无法生成。</span><button type="button" onClick={() => setRetry(n => n + 1)}>重试预览</button></> : state === 'loading' ? '正在生成画面…' : live ? '随工作状态与展示规则自动更新。' : sample ? '仅在桌面演示，不会更改设备内容或配置。' : `画面版本 ${manifest.firmwareVersion} · 调整后即时预览，点击「应用配置」才保存。`}</div>
    <p className="device-preview-note">{live ? '实体屏的温湿度、电量和刷新回执尚未回传；未知读数不会替换为模拟数据。' : '温湿度、电量和联网标记暂未回传，预览显示未知／未连接。这里展示目标画面，不代表实机已经刷新，也不模拟闪烁与残影。'}</p>
  </div>
}
