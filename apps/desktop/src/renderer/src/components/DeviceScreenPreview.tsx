import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  deviceInspectScale,
  devicePixelRatioLabel,
  devicePreviewScale,
  type DeviceStatusV1,
} from '@codepulse/shared'
import { createDevicePlaneRenderer, planesToRgba } from '../device-preview/renderer.mjs'
import manifest from '../device-preview/manifest.json'

let renderer: ReturnType<typeof createDevicePlaneRenderer> | undefined
function loadRenderer(): ReturnType<typeof createDevicePlaneRenderer> {
  if (!renderer) {
    // Embedded bytes also work in packaged Electron's file:// renderer. The
    // large payload is a lazy chunk and needs no network or file fetch API.
    renderer = import('../device-preview/renderer.b64?raw')
      .then(({ default: encoded }) => {
        return createDevicePlaneRenderer(
          Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0)),
        )
      })
      .catch((error) => {
        renderer = undefined
        throw error
      })
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
    return () => {
      query?.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return dpr
}

const sides = (style: CSSStyleDeclaration, ...names: string[]) =>
  names.reduce((sum, name) => sum + (parseFloat(style.getPropertyValue(name)) || 0), 0)

const STAGE = '.product-preview-stage'
/** Where the stage's content ends, minus the frame's own height: what the other content costs, in px. */
const othersHeight = (host: HTMLElement, frame: HTMLElement): number => {
  const top = host.getBoundingClientRect().top - host.scrollTop
  return (
    Math.max(0, ...Array.from(host.children, (child) => child.getBoundingClientRect().bottom)) -
    top -
    frame.offsetHeight
  )
}

/**
 * Room for the canvas: the scroll area's width minus the frame's padding and border and, inside a
 * fixed-height preview stage, the height left before the stage would have to scroll.
 *
 * A fresh measurement (width or stage size changed) renders at the preferred scale first; if the stage
 * then overflows, the height is capped (before paint) and the cost of the other content is remembered.
 * The cap is only lifted for another look when that cost has shrunk by more than a pixel or the
 * measurement is renewed; a lift that overflows again re-caps with the new, smaller cost. The cost
 * can only fall, so the sequence ends, and our own canvas resizing never counts as a change.
 * Content that grows into an overflow while uncapped just triggers one more render to cap it.
 */
function useAvailableSize(
  scroll: RefObject<HTMLElement>,
  frame: RefObject<HTMLElement>,
): { width: number; height: number } {
  const [size, setSize] = useState({ width: Infinity, height: Infinity })
  const measured = useRef('')
  const cappedAt = useRef<number | undefined>(undefined)
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const host = element.closest<HTMLElement>(STAGE)
    const measure = () => {
      const key = `${element.clientWidth}x${host?.clientHeight ?? 0}`
      if (key !== measured.current) {
        measured.current = key
        cappedAt.current = undefined
        const style = frame.current ? getComputedStyle(frame.current) : undefined
        const chrome = style
          ? sides(style, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width')
          : 0
        setSize({ width: Math.max(0, element.clientWidth - chrome), height: Infinity })
      } else if (
        host &&
        frame.current &&
        cappedAt.current !== undefined &&
        othersHeight(host, frame.current) < cappedAt.current - 1
      ) {
        cappedAt.current = undefined
        setSize((current) => ({ ...current, height: Infinity }))
      } else if (
        host &&
        cappedAt.current === undefined &&
        host.scrollHeight - host.clientHeight > 1
      ) {
        setSize((current) => ({ ...current })) // content grew: render again so the layout effect can cap
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const mutations = new MutationObserver(measure)
    if (host) {
      observer.observe(host)
      mutations.observe(host, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'open'],
      })
    }
    return () => {
      observer.disconnect()
      mutations.disconnect()
      measured.current = ''
    }
  }, [scroll, frame])
  useLayoutEffect(() => {
    const host = scroll.current?.closest<HTMLElement>(STAGE)
    const element = frame.current
    if (!host || !element || size.height !== Infinity) return
    const overflow = host.scrollHeight - host.clientHeight
    if (overflow <= 1) return
    cappedAt.current = othersHeight(host, element)
    setSize({
      ...size,
      height: Math.max(
        0,
        element.offsetHeight -
          overflow -
          sides(
            getComputedStyle(element),
            'padding-top',
            'padding-bottom',
            'border-top-width',
            'border-bottom-width',
          ),
      ),
    })
  })
  return size
}

/**
 * Nudge the frame so the canvas starts on a physical pixel. At a fractional phase the 400k-pixel
 * canvas paints as 400k-1 or 400k+1 pixels wide and 1-pixel strokes turn uneven. Layout units are 1/64 CSS px,
 * so "on a pixel" means within 0.03 physical pixels.
 */
function useWholePixelAlign(
  canvas: RefObject<HTMLElement>,
  frame: RefObject<HTMLElement>,
  scroll: RefObject<HTMLElement>,
  dpr: number,
): void {
  const offset = useRef({ x: 0, y: 0 })
  const align = () => {
    const box = frame.current
    if (!box || !canvas.current) return
    const rect = canvas.current.getBoundingClientRect()
    const phase = (value: number) => (value * dpr - Math.round(value * dpr)) / dpr
    const dx = phase(rect.left),
      dy = phase(rect.top)
    if (Math.abs(dx * dpr) < 0.03 && Math.abs(dy * dpr) < 0.03) return
    // Whole-pixel translations have the same phase. Keep only the fractional offset so repeated
    // resizes cannot drift the frame away from its controls while the canvas remains pixel-aligned.
    offset.current = { x: phase(offset.current.x - dx), y: phase(offset.current.y - dy) }
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
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', align)
    }
  }, [scroll, dpr])
}

export interface DeviceScreenPreviewProps {
  status: DeviceStatusV1
  active?: boolean
  sample?: boolean
  live?: boolean
  fit?: boolean
  options?: ReactNode
  collapsibleOptions?: boolean
  /** ia-2: title/actions plus a portal menu; legacy callers keep their existing chrome. */
  compact?: boolean
  heading?: ReactNode
  headerActions?: ReactNode
  cornerTag?: ReactNode
}
export function DeviceScreenPreview({
  status,
  sample = false,
  live = false,
  fit = false,
  active = true,
  options,
  collapsibleOptions = false,
  compact = false,
  heading,
  headerActions,
  cornerTag,
}: DeviceScreenPreviewProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const enlargedCanvas = useRef<HTMLCanvasElement>(null)
  const inspector = useRef<HTMLDialogElement>(null)
  const inspectorTitle = useId()
  const inspectTrigger = useRef<HTMLButtonElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuTheme, setMenuTheme] = useState<Record<string, string>>({})
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, width: 320, maxHeight: 320 })
  const closeMenu = useCallback((focus = false) => {
    setMenuOpen(false)
    if (focus) menuTrigger.current?.focus()
  }, [])
  const [retry, setRetry] = useState(0)
  const lastFrame = useRef('')
  const scroll = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const dpr = useDevicePixelRatio()
  const available = useAvailableSize(scroll, frame)
  const scale = devicePreviewScale(dpr, available.width, false, available.height)
  const inspectScale = deviceInspectScale(dpr)
  useWholePixelAlign(canvas, frame, scroll, dpr)
  useLayoutEffect(() => {
    if (!menuOpen || !menu.current || !menuTrigger.current) return
    const bounds = menuTrigger.current.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 32)
    const height = Math.min(
      menu.current.scrollHeight + menu.current.offsetHeight - menu.current.clientHeight,
      window.innerHeight - 32,
    )
    const below = window.innerHeight - bounds.bottom - 24
    const above = bounds.top - 24
    const upwards = below < height && above > below
    const next = {
      left: Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16)),
      top: upwards ? Math.max(16, bounds.top - 8 - Math.min(height, above)) : bounds.bottom + 8,
      width,
      maxHeight: Math.max(32, upwards ? above : below),
    }
    setMenuPosition((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    )
  }, [menuOpen, options, headerActions])
  useEffect(() => {
    if (!menuOpen) return
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !menuTrigger.current?.contains(event.target as Node)
      )
        closeMenu()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
      }
    }
    const moved = () => closeMenu()
    const focusMoved = (event: FocusEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !menuTrigger.current?.contains(event.target as Node)
      )
        closeMenu()
    }
    const scrolled = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) closeMenu()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    document.addEventListener('focusin', focusMoved)
    document.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', moved)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', key)
      document.removeEventListener('focusin', focusMoved)
      document.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('resize', moved)
    }
  }, [menuOpen, closeMenu])
  useEffect(() => {
    if (!active) closeMenu()
  }, [active, closeMenu])
  const toggleMenu = () => {
    if (menuOpen) {
      closeMenu(true)
      return
    }
    const computed = getComputedStyle(menuTrigger.current!)
    const theme = Object.fromEntries(
      Array.from(computed)
        .filter((name) => name.startsWith('--'))
        .map((name) => [name, computed.getPropertyValue(name)]),
    )
    setMenuTheme({ ...theme, fontFamily: computed.fontFamily })
    setMenuOpen(true)
  }
  useEffect(() => {
    if (!active) return
    const key = JSON.stringify(status)
    if (lastFrame.current === key && retry === 0) {
      setState('ready')
      return
    }
    let alive = true
    if (!lastFrame.current) setState('loading')
    // Give the selected card a paint before compiling/rasterizing a cold preview.
    const timer = setTimeout(() => {
      void loadRenderer()
        .then((render) => {
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
        })
        .catch(() => {
          if (alive) setState('error')
        })
    }, 32)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [status, retry, active])
  const description = status.ambient
    ? `桌边内容，${status.ambient.source}：${status.ambient.text}`
    : status.display?.mode === 'usage'
      ? `用量看板，${status.display.agents.length} 个账号`
      : `HUD 工作，${status.threads?.length ?? 0} 个线程。${(status.threads ?? []).map((t) => t.title).join('；')}`
  const toolbar = (
    <div className="device-preview-toolbar">
      <span>
        {live ? '当前目标画面' : status.ambient ? '内容预览' : sample ? '样例画面' : '最新任务画面'}{' '}
        · 400 × 300
      </span>
      <div>
        <span className="device-preview-scale">{devicePixelRatioLabel(scale.k)}</span>
        <button ref={inspectTrigger} type="button" onClick={() => inspector.current?.showModal()}>
          2 倍检查
        </button>
      </div>
    </div>
  )
  const hasHeader = Boolean(compact && (heading || headerActions))
  const moreButton = (
    <button
      ref={menuTrigger}
      type="button"
      className="product-button device-preview-more"
      aria-label="预览选项"
      title="预览选项"
      aria-haspopup="dialog"
      aria-expanded={menuOpen}
      aria-controls={menuId}
      onClick={toggleMenu}
    >
      ⋯
    </button>
  )
  return (
    <div
      className={'device-preview ' + (fit ? 'device-preview-fit' : '')}
      data-render-state={state}
      data-pixel-ratio={scale.k}
    >
      {/* The preview state stays available to assistive tech without a visible pill. */}
      {compact && cornerTag && (
        <span className="device-preview-tag sr-only" role="status">
          {cornerTag}
        </span>
      )}
      {hasHeader && (
        <div className="device-preview-header">
          {heading && <h2>{heading}</h2>}
          <div className="device-preview-header-actions">
            {headerActions}
            {moreButton}
          </div>
        </div>
      )}
      {!compact && !collapsibleOptions && toolbar}
      <div className="device-preview-picture">
        <div ref={scroll} className="device-preview-scroll" aria-busy={state === 'loading'}>
          <div className={compact ? 'device-preview-stagebox' : undefined}>
            {compact && !hasHeader && <div className="device-preview-framebar">{moreButton}</div>}
            <div ref={frame} className="device-preview-frame" style={{ width: scale.cssWidth }}>
              <canvas
                ref={canvas}
                width={400}
                height={300}
                className="device-screen"
                style={{
                  width: scale.cssWidth,
                  height: scale.cssHeight,
                  visibility: state === 'error' ? 'hidden' : 'visible',
                }}
                role="img"
                aria-label={description}
              >
                {description}
              </canvas>
            </div>
          </div>
        </div>
      </div>
      {!compact && collapsibleOptions && (
        <details className="ink-preview-options">
          <summary>预览选项</summary>
          <div className="ink-preview-options-body">
            {toolbar}
            {options}
          </div>
        </details>
      )}
      {compact &&
        menuOpen &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            className="device-preview-menu"
            role="dialog"
            aria-label="预览选项"
            style={{ ...menuTheme, ...menuPosition }}
          >
            <div className="device-preview-menu-row">
              <span>比例</span>
              <div className="device-preview-menu-buttons" role="group" aria-label="显示比例">
                <button
                  type="button"
                  aria-pressed="true"
                  title={devicePixelRatioLabel(scale.k)}
                  onClick={() => closeMenu(true)}
                >
                  1:1
                </button>
                <button
                  ref={inspectTrigger}
                  type="button"
                  onClick={() => {
                    closeMenu()
                    inspector.current?.showModal()
                  }}
                >
                  2×
                </button>
              </div>
            </div>
            {options}
          </div>,
          document.body,
        )}
      {compact && state !== 'ready' && (
        <div className="device-preview-note" role={state === 'error' ? 'alert' : 'status'}>
          {state === 'loading' ? (
            '正在生成画面…'
          ) : (
            <>
              <span>预览暂时无法生成。</span>
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                重试预览
              </button>
            </>
          )}
        </div>
      )}
      {!compact && (
        <div className="device-preview-footnote">
          <div className="device-preview-note" aria-live="polite">
            {state === 'error' ? (
              <>
                <span>预览暂时无法生成。</span>
                <button type="button" onClick={() => setRetry((n) => n + 1)}>
                  重试预览
                </button>
              </>
            ) : state === 'loading' ? (
              '正在生成画面…'
            ) : sample ? (
              '仅供预览，不会发送到设备。'
            ) : live ? (
              '目标画面随工作状态自动更新。'
            ) : (
              '更改即时预览，应用后才保存。'
            )}
          </div>
          <details className="device-preview-info">
            <summary>预览说明</summary>
            <p>
              画面版本 {manifest.firmwareVersion}
              。预览保持原始像素，按屏幕物理像素整数倍显示，放大检查至少为 2
              倍。温湿度、电量和联网读数未回传时显示未知；目标画面不代表实体屏已刷新，也不模拟残影。
            </p>
          </details>
        </div>
      )}
      <dialog
        ref={inspector}
        className="device-preview-inspector"
        aria-labelledby={inspectorTitle}
        onClose={() => (compact ? menuTrigger : inspectTrigger).current?.focus()}
      >
        <header>
          <div>
            <h2 id={inspectorTitle}>放大检查</h2>
            {!compact && <p>400 × 300 · {devicePixelRatioLabel(inspectScale.k)} · 保留原始像素</p>}
          </div>
          <button
            type="button"
            className="product-button"
            autoFocus
            onClick={() => inspector.current?.close()}
          >
            关闭检查
          </button>
        </header>
        <div
          className="device-inspector-viewport"
          tabIndex={0}
          aria-label="放大画面，小窗口可滚动查看"
        >
          <canvas
            ref={enlargedCanvas}
            width={400}
            height={300}
            className="device-screen"
            style={{
              width: inspectScale.cssWidth,
              height: inspectScale.cssHeight,
              visibility: state === 'error' ? 'hidden' : 'visible',
            }}
            role="img"
            aria-label={description}
          >
            {description}
          </canvas>
        </div>
        {(state === 'error' || !compact) && (
          <p className="device-inspector-caption">
            {state === 'error'
              ? '画面生成失败，请关闭检查后重试。'
              : '此处仅检查目标像素，不改变设备配置。按 Esc 返回。'}
          </p>
        )}
      </dialog>
    </div>
  )
}
