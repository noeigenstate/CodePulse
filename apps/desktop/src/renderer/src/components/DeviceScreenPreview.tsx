import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
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

const sides = (style: CSSStyleDeclaration, ...names: string[]) => names.reduce((sum, name) => sum + (parseFloat(style.getPropertyValue(name)) || 0), 0)

/**
 * Room for the canvas: the scroll area's width minus the frame's padding and border and, inside a
 * fixed-height preview stage, the height left before the stage would have to scroll.
 */
function useAvailableSize(scroll: RefObject<HTMLElement>, frame: RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: Infinity, height: Infinity })
  const measured = useRef('')
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const host = element.closest<HTMLElement>('.product-preview-stage')
    const measure = () => {
      const key = `${element.clientWidth}x${host?.clientHeight ?? 0}`
      if (key === measured.current) return
      measured.current = key
      const style = frame.current ? getComputedStyle(frame.current) : undefined
      const chrome = style ? sides(style, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width') : 0
      setSize({ width: Math.max(0, element.clientWidth - chrome), height: Infinity })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (host) observer.observe(host)
    return () => { observer.disconnect(); measured.current = '' }
  }, [scroll, frame])
  // A fresh measurement renders at the preferred scale first; if the stage then overflows, cap the height.
  useLayoutEffect(() => {
    const host = scroll.current?.closest<HTMLElement>('.product-preview-stage')
    const element = frame.current
    if (!host || !element || size.height !== Infinity) return
    const overflow = host.scrollHeight - host.clientHeight
    if (overflow > 1) setSize({ ...size, height: Math.max(0, element.offsetHeight - overflow - sides(getComputedStyle(element), 'padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width')) })
  })
  return size
}

export function DeviceScreenPreview({ status, sample = false, live = false, fit = false, active = true }: { status: DeviceStatusV1; active?: boolean; sample?: boolean; live?: boolean; fit?: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const enlargedCanvas = useRef<HTMLCanvasElement>(null)
  const inspector = useRef<HTMLDialogElement>(null)
  const inspectorTitle = useId()
  const inspectTrigger = useRef<HTMLButtonElement>(null)
  const [retry, setRetry] = useState(0)
  const lastFrame = useRef('')
  const scroll = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const dpr = useDevicePixelRatio()
  const available = useAvailableSize(scroll, frame)
  const scale = devicePreviewScale(dpr, available.width, false, available.height)
  const inspectScale = deviceInspectScale(dpr)
  useEffect(() => {
    if (!active) return
    const key = JSON.stringify(status)
    if (lastFrame.current === key && retry === 0) { setState('ready'); return }
    let alive = true
    if (!lastFrame.current) setState('loading')
    // Give the selected card a paint before compiling/rasterizing a cold preview.
    const timer = setTimeout(() => { void loadRenderer().then(render => {
      if (!alive) return
      const { black, red } = render(status)
      const pixels = planesToRgba(black, red)
      for (const target of [canvas.current, enlargedCanvas.current]) {
        const context = target?.getContext('2d')
        if (!context) throw new Error('Canvas unavailable')
        context.imageSmoothingEnabled = false
        const image = context.createImageData(400, 300)
        image.data.set(pixels)
        context.putImageData(image, 0, 0)
      }
      lastFrame.current = key
      setState('ready')
    }).catch(() => { if (alive) setState('error') }) }, 32)
    return () => { alive = false; clearTimeout(timer) }
  }, [status, retry, active])
  const description = status.ambient ? `桌边动态，${status.ambient.source}：${status.ambient.text}` : status.display?.mode === 'usage'
    ? `用量看板，${status.display.agents.length} 个账号`
    : `HUD 工作，${status.threads?.length ?? 0} 个线程。${(status.threads ?? []).map(t => t.title).join('；')}`
  return <div className={'device-preview ' + (fit ? 'device-preview-fit' : '')} data-render-state={state} data-pixel-ratio={scale.k}>
    <div className="device-preview-toolbar">
      <span>{live ? '当前目标画面' : status.ambient ? '内容预览' : sample ? '样例画面' : '最新任务画面'} · 400 × 300</span>
      <div><span className="device-preview-scale">{devicePixelRatioLabel(scale.k)}</span><button ref={inspectTrigger} type="button" onClick={() => inspector.current?.showModal()}>2 倍检查</button></div>
    </div>
    <div ref={scroll} className="device-preview-scroll" aria-busy={state === 'loading'}>
      <div ref={frame} className="device-preview-frame" style={{ width: scale.cssWidth }}>
        <canvas ref={canvas} width={400} height={300} className="device-screen" style={{ width: scale.cssWidth, height: scale.cssHeight, visibility: state === 'error' ? 'hidden' : 'visible' }} role="img" aria-label={description}>{description}</canvas>
      </div>
    </div>
    <div className="device-preview-footnote">
      <div className="device-preview-note" aria-live="polite">
        {state === 'error' ? <><span>预览暂时无法生成。</span><button type="button" onClick={() => setRetry(n => n + 1)}>重试预览</button></> : state === 'loading' ? '正在生成画面…' : sample ? '仅供预览，不会发送到设备。' : live ? '目标画面随工作状态自动更新。' : '更改即时预览，应用后才保存。'}
      </div>
      <details className="device-preview-info">
        <summary>预览说明</summary>
        <p>画面版本 {manifest.firmwareVersion}。预览保持原始像素，按屏幕物理像素整数倍显示，放大检查至少为 2 倍。温湿度、电量和联网读数未回传时显示未知；目标画面不代表实体屏已刷新，也不模拟残影。</p>
      </details>
    </div>
    <dialog ref={inspector} className="device-preview-inspector" aria-labelledby={inspectorTitle} onClose={() => inspectTrigger.current?.focus()}>
      <header>
        <div><h2 id={inspectorTitle}>放大检查</h2><p>400 × 300 · {devicePixelRatioLabel(inspectScale.k)} · 保留原始像素</p></div>
        <button type="button" className="product-button" autoFocus onClick={() => inspector.current?.close()}>关闭检查</button>
      </header>
      <div className="device-inspector-viewport" tabIndex={0} aria-label="放大画面，小窗口可滚动查看">
        <canvas ref={enlargedCanvas} width={400} height={300} className="device-screen" style={{ width: inspectScale.cssWidth, height: inspectScale.cssHeight, visibility: state === 'error' ? 'hidden' : 'visible' }} role="img" aria-label={description}>{description}</canvas>
      </div>
      <p className="device-inspector-caption">{state === 'error' ? '画面生成失败，请关闭检查后重试。' : '此处仅检查目标像素，不改变设备配置。按 Esc 返回。'}</p>
    </dialog>
  </div>
}
