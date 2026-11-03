import { useEffect, useState } from 'react'
import type {
  AmbientSnapshot,
  YuanbaoAuthMode,
  YuanbaoStatus,
  YuanbaoTestResult,
} from '@codepulse/shared'
import { InfoTip } from './InfoTip.js'
import { syncAuthMode } from '../lib/yuanbaoStatus.js'

/**
 * 元宝搜索 key and connection settings. A key goes only from these password fields to the main
 * process: each field submits once and is cleared in the same tick, nothing is echoed back, and the
 * placeholder says 「已保存」 only when the host reports a saved key.
 */
export function YuanbaoSettings({
  status,
  limit,
  onLimit,
  onSnapshot,
  disabled,
  limitField,
}: {
  status: YuanbaoStatus | undefined
  limit: number
  onLimit: (value: number) => void
  onSnapshot: (snapshot: AmbientSnapshot) => void
  disabled: boolean
  /** The shared number field renderer (commits on blur or Enter). */
  limitField: (value: number, onCommit: (value: number) => void) => JSX.Element
}): JSX.Element {
  const [mode, setMode] = useState<YuanbaoAuthMode>(status?.authMode ?? 'tc3')
  const [touched, setTouched] = useState(false)
  // The saved mode wins until the user picks one themselves (the first snapshot usually arrives after mount).
  useEffect(
    () => setMode((current) => syncAuthMode(current, touched, status?.authMode)),
    [status?.authMode, touched],
  )
  const [secretId, setSecretId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<YuanbaoTestResult>()
  const hasKey = Boolean(status?.hasKey)
  const savedHere = hasKey && status?.authMode === mode
  const clearFields = () => {
    setSecretId('')
    setSecretKey('')
    setApiKey('')
  }
  const canSave =
    mode === 'tc3' ? Boolean(secretId.trim() && secretKey.trim()) : Boolean(apiKey.trim())

  async function save() {
    if (!canSave || busy) return
    // Take the values and empty the fields before anything is awaited.
    const input =
      mode === 'tc3'
        ? { secretId: secretId.trim(), secretKey: secretKey.trim() }
        : { apiKey: apiKey.trim() }
    clearFields()
    setBusy(true)
    setNote('')
    try {
      onSnapshot(await window.codepulse.setYuanbaoKey(input))
      setNote('已保存')
    } catch {
      setNote('保存失败，请检查系统加密存储')
    } finally {
      setBusy(false)
    }
  }
  async function clear() {
    clearFields()
    setBusy(true)
    setNote('')
    try {
      onSnapshot(
        await window.codepulse.setYuanbaoKey(
          mode === 'tc3' ? { secretId: '', secretKey: '' } : { apiKey: '' },
        ),
      )
      setTest(undefined)
      setNote('已清除')
    } catch {
      setNote('清除失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  async function runTest() {
    if (!hasKey || busy) return
    setBusy(true)
    setNote('')
    setTest(undefined)
    try {
      setTest(await window.codepulse.testYuanbao())
      onSnapshot(await window.codepulse.getAmbient())
    } catch {
      setTest({
        ok: false,
        latencyMs: null,
        edition: null,
        cardText: '',
        error: '测试未完成，请重试',
      })
    } finally {
      setBusy(false)
    }
  }
  const stats = [
    status ? `今日 ${status.requestsToday}/${status.limit}` : '',
    status?.lastLatencyMs != null ? `${status.lastLatencyMs} ms` : '',
    status?.sources.length ? status.sources.join('、') : '',
  ].filter(Boolean)

  return (
    <details className="ambient-details ambient-yuanbao">
      <summary>元宝搜索设置</summary>
      <fieldset className="ambient-fieldset" disabled={disabled}>
        <div className="ambient-yuanbao-mode">
          <div className="page-segmented" role="group" aria-label="认证方式">
            <button
              type="button"
              aria-pressed={mode === 'tc3'}
              title="SecretId + SecretKey"
              onClick={() => {
                clearFields()
                setTouched(true)
                setMode('tc3')
              }}
            >
              SecretId/Key
            </button>
            <button
              type="button"
              aria-pressed={mode === 'apikey'}
              title="API Key"
              onClick={() => {
                clearFields()
                setTouched(true)
                setMode('apikey')
              }}
            >
              API Key
            </button>
          </div>
          <InfoTip text="密钥通过系统加密保存在本机，不会回传到界面" label="密钥如何保存" />
        </div>
        <form
          className="ambient-yuanbao-keys"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {mode === 'tc3' ? (
            <>
              <label className="page-field">
                SecretId
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secretId}
                  placeholder={savedHere ? '已保存' : ''}
                  onChange={(event) => setSecretId(event.target.value)}
                />
              </label>
              <label className="page-field">
                SecretKey
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secretKey}
                  placeholder={savedHere ? '已保存' : ''}
                  onChange={(event) => setSecretKey(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label className="page-field">
              API Key
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                placeholder={savedHere ? '已保存' : ''}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          )}
          <div className="ambient-actions">
            <button type="submit" className="product-button" disabled={!canSave || busy}>
              保存
            </button>
            <button
              type="button"
              className="product-button"
              disabled={!savedHere || busy}
              onClick={() => void clear()}
            >
              清除
            </button>
            <button
              type="button"
              className="product-button"
              disabled={!hasKey || busy}
              onClick={() => void runTest()}
            >
              测试连接
            </button>
          </div>
        </form>
        {limitField(limit, onLimit)}
        <p className="ambient-message" data-feedback="yuanbao" role="status">
          {note ||
            (test
              ? test.ok
                ? `连接正常 · ${test.latencyMs ?? '—'} ms · ${test.edition ?? '—'} · ${test.cardText}`
                : test.error
              : (status?.lastError ?? ''))}
        </p>
        {stats.length > 0 && (
          <p className="ambient-yuanbao-stats" role="status">
            {stats.join(' · ')}
          </p>
        )}
      </fieldset>
    </details>
  )
}
