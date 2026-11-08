import { useCallback, useEffect, useRef, useState } from 'react'
import { retainCloudPlugins, type CloudPluginsState } from '../lib/pluginPresentation.js'

/** A feed update can emit several notifications; only read the final installation state. */
export function useCloudPlugins(active: boolean) {
  const [cloud, setCloud] = useState<CloudPluginsState>()
  const [logos, setLogos] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const alive = useRef(false)
  const visible = useRef(active)
  visible.current = active
  const sequence = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const refresh = useCallback(async () => {
    clearTimeout(timer.current)
    const request = ++sequence.current
    setLoading(true)
    const [installs, images] = await Promise.allSettled([
      window.codepulse.listCloudPlugins(),
      window.codepulse.pluginLogos(),
    ])
    if (!alive.current || request !== sequence.current) return
    setLoading(false)
    setCloud((previous) =>
      retainCloudPlugins(
        previous,
        installs.status === 'fulfilled'
          ? installs.value
          : { state: 'offline', platformOrigin: '', plugins: [] },
      ),
    )
    if (images.status === 'fulfilled') {
      setLogos(images.value)
      setError('')
    } else setError('本机图标暂不可用，请重试。')
  }, [])
  useEffect(() => {
    alive.current = true
    const stop = window.codepulse.onPluginsChanged(() => {
      if (!visible.current) return
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void refresh(), 300)
    })
    return () => {
      alive.current = false
      ++sequence.current
      clearTimeout(timer.current)
      stop()
    }
  }, [refresh])
  useEffect(() => {
    if (active) void refresh()
    else clearTimeout(timer.current)
  }, [active, refresh])
  return { cloud, logos, error, loading, refresh }
}
