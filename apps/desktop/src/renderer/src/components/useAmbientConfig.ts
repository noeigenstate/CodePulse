import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AMBIENT,
  normalizeAmbient,
  type AmbientConfig,
  type AmbientSnapshot,
} from '@codepulse/shared'

/** One source of draft/save state for plugin settings and the standalone workbench. */
export function useAmbientConfig() {
  const [snapshot, setSnapshot] = useState<AmbientSnapshot>()
  const [draft, setDraft] = useState<AmbientConfig>({ ...DEFAULT_AMBIENT })
  const [savedFlash, setSavedFlash] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [loadError, setLoadError] = useState('')
  const savedConfig = useRef<AmbientConfig>()
  const draftRef = useRef(draft)
  draftRef.current = draft
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()
  const unsaved = useRef(false)
  const saveSeq = useRef(0)
  useEffect(() => {
    let alive = true,
      received = false
    void window.codepulse
      .getAmbient()
      .then((s) => {
        if (alive && !received) {
          setLoadError('')
          setSnapshot(s)
          // A host that predates a setting (or sends an odd value) must not break the page.
          savedConfig.current = normalizeAmbient(s.config)
          setDraft(savedConfig.current)
        }
      })
      .catch(() => {
        if (alive) setLoadError('本机插件暂不可用，请重新启动统一应用。')
      })
    const stop = window.codepulse.onAmbient((s) => {
      received = true
      if (!alive) return
      setLoadError('')
      setSnapshot(s)
      const incoming = normalizeAmbient(s.config)
      if (JSON.stringify(savedConfig.current) !== JSON.stringify(incoming)) {
        savedConfig.current = incoming
        // Never overwrite what the user is typing; the pending save carries it.
        if (!unsaved.current) setDraft(incoming)
      }
    })
    return () => {
      alive = false
      stop()
      clearTimeout(saveTimer.current)
      clearTimeout(flashTimer.current)
    }
  }, [])

  /**
   * Rules save by themselves. `enabled` and `displayMinutes` belong to the playlist in 控制 and are
   * never taken from the draft: the last saved values go back with every write.
   */
  async function persist(next: AmbientConfig) {
    const seq = ++saveSeq.current
    const base = savedConfig.current
    try {
      const state = await window.codepulse.setAmbient(
        base ? { ...next, enabled: base.enabled, displayMinutes: base.displayMinutes } : next,
      )
      savedConfig.current = normalizeAmbient(state.config)
      setSnapshot(state)
      if (seq === saveSeq.current) unsaved.current = false
      setSaveFailed(false)
      setSavedFlash(true)
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), 1800)
    } catch {
      if (seq === saveSeq.current) unsaved.current = false
      setSavedFlash(false)
      setSaveFailed(true)
    }
  }
  const editMany = (patch: Partial<AmbientConfig>, delay = 0) => {
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
    unsaved.current = true
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void persist(draftRef.current), delay)
  }
  const edit = <K extends keyof AmbientConfig>(name: K, value: AmbientConfig[K], delay = 0) =>
    editMany({ [name]: value } as Partial<AmbientConfig>, delay)
  return {
    snapshot,
    setSnapshot,
    draft,
    draftRef,
    edit,
    editMany,
    savedFlash,
    saveFailed,
    loadError,
  }
}
