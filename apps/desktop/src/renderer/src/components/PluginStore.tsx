import { useEffect, useRef, useState } from 'react'
import { pluginStoreThemeUrl } from '../lib/pluginStoreTheme.js'
import { ProductIcon } from './ProductFrame.js'
import './plugin-store.css'

const rendererTheme = () =>
  document.documentElement.dataset.theme === 'dark' ? ('dark' as const) : ('light' as const)

const MISMATCH = '平台地址与构建配置不一致，请使用同一平台地址重新构建。'

export function PluginStore({ route }: { route?: string }): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  const storeLocation = useRef('')
  useEffect(() => {
    let alive = true
    setUrl('')
    storeLocation.current = ''
    setError('')
    setReason('')
    setLoading(true)
    void window.codepulse
      .openPlugins({ embed: true, route, theme: rendererTheme() })
      .then((result) => {
        if (!alive) return
        if ('url' in result) {
          // The scheduled renderer theme may have changed while the login URL was requested.
          const initial = new URL(result.url)
          initial.searchParams.set('theme', rendererTheme())
          storeLocation.current = initial.href
          setUrl(initial.href)
        } else {
          setError(result.error)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!alive) return
        setError('插件平台未连接')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [attempt, route])
  useEffect(() => {
    let theme = rendererTheme()
    const observer = new MutationObserver(() => {
      const next = rendererTheme()
      if (next === theme) return
      theme = next
      if (!storeLocation.current) return
      storeLocation.current = pluginStoreThemeUrl(storeLocation.current, next)
      setUrl(storeLocation.current)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  useEffect(
    () =>
      window.codepulse.onPluginsLocation((next) => {
        if (storeLocation.current && new URL(next).origin === new URL(storeLocation.current).origin)
          storeLocation.current = next
      }),
    [],
  )
  useEffect(
    () =>
      window.codepulse.onPluginsLoadError(() => {
        setError('插件平台未连接')
        setLoading(false)
      }),
    [],
  )
  useEffect(() => {
    const blocked = (event: SecurityPolicyViolationEvent) => {
      if (event.effectiveDirective !== 'frame-src') return
      setError('插件平台未连接')
      setReason(MISMATCH)
      setLoading(false)
    }
    document.addEventListener('securitypolicyviolation', blocked)
    return () => document.removeEventListener('securitypolicyviolation', blocked)
  }, [])
  useEffect(() => {
    if (!url) return
    const origin = new URL(url).origin
    const message = (event: MessageEvent) => {
      if (
        event.origin === origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === 'codepulse:installs-changed'
      ) {
        void window.codepulse.pluginsChanged().catch(() => {})
      }
    }
    window.addEventListener('message', message)
    return () => {
      window.removeEventListener('message', message)
    }
  }, [url])
  useEffect(() => {
    if (!url || !loading) return
    const timer = window.setTimeout(() => {
      setError('插件平台未连接')
      setLoading(false)
    }, 15000)
    return () => window.clearTimeout(timer)
  }, [url, loading])
  return (
    <section className="product-page plugin-store" aria-label="插件">
      {loading && (
        <p className="page-muted plugin-store-state" role="status">
          正在连接插件平台…
        </p>
      )}
      {error && (
        <div className="plugin-store-state" role="alert">
          <header className="page-header">
            <div>
              <h1>
                <ProductIcon name="plugins" />
                {error}
              </h1>
              <p>{reason || '请检查平台服务和网络连接。'}</p>
            </div>
          </header>
          <button type="button" className="product-button" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {url && !error && (
        <iframe
          ref={frame}
          title="CodePulse 插件平台"
          src={url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false)
            setError('插件平台未连接')
          }}
        />
      )}
    </section>
  )
}
