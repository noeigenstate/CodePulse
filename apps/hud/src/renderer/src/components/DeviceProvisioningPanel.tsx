import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  CodePulseUsbDevice,
  DeviceProvisioningRequest,
  DeviceProvisioningSnapshot,
} from '@codepulse/shared'
import type { DeviceProvisioningCopy } from '../lib/i18n.js'

interface Props {
  copy: DeviceProvisioningCopy
}

const EMPTY_SNAPSHOT: DeviceProvisioningSnapshot = {
  serverAvailable: false,
  scanning: false,
  devices: [],
  displays: [],
  phase: 'idle',
  updatedAt: 0,
}

/** USB 配网面板。密码只保存在组件内存中，并在提交/卸载时立即清空。 */
export function DeviceProvisioningPanel({ copy }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<DeviceProvisioningSnapshot>(EMPTY_SNAPSHOT)
  const [selectedPath, setSelectedPath] = useState('')
  const [wifiSsid, setWifiSsid] = useState('')
  const [wifiPassword, setWifiPassword] = useState('')
  const [fallbackHost, setFallbackHost] = useState('')
  const [ipcUnavailable, setIpcUnavailable] = useState(false)
  const activeRef = useRef(false)

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.codepulse.onDeviceProvisioning((next) => {
      if (!mounted) return
      activeRef.current = isProvisioning(next)
      setSnapshot(next)
    })
    void window.codepulse
      .getDeviceProvisioning()
      .then((initial) => {
        if (!mounted) return initial
        activeRef.current = isProvisioning(initial)
        setSnapshot(initial)
        setFallbackHost((current) => current || initial.fallbackHost || '')
        return window.codepulse.startDeviceScan()
      })
      .then((started) => {
        if (mounted) setSnapshot(started)
      })
      .catch(() => {
        if (mounted) setIpcUnavailable(true)
      })

    return () => {
      mounted = false
      unsubscribe()
      setWifiPassword('')
      void window.codepulse.stopDeviceScan()
      if (activeRef.current) void window.codepulse.cancelDeviceProvisioning()
    }
  }, [])

  useEffect(() => {
    if (selectedPath && snapshot.devices.some((device) => device.path === selectedPath)) return
    const first = snapshot.devices[0]
    setSelectedPath(first?.path ?? '')
    if (first?.config?.wifiSsid) setWifiSsid(first.config.wifiSsid)
  }, [selectedPath, snapshot.devices])

  useEffect(() => {
    if (!fallbackHost && snapshot.fallbackHost) setFallbackHost(snapshot.fallbackHost)
  }, [fallbackHost, snapshot.fallbackHost])

  const selected = useMemo(
    () => snapshot.devices.find((device) => device.path === selectedPath),
    [selectedPath, snapshot.devices],
  )
  const active = isProvisioning(snapshot)
  const displayVerified = snapshot.displays.some(
    (display) => display.deviceId === snapshot.activeDeviceId,
  )
  const canSubmit =
    Boolean(selected) &&
    snapshot.serverAvailable &&
    wifiSsid.trim().length > 0 &&
    !active &&
    !ipcUnavailable

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!selected || !canSubmit) return
    const request: DeviceProvisioningRequest = {
      path: selected.path,
      deviceId: selected.deviceId,
      wifiSsid,
      wifiPassword,
      ...(fallbackHost.trim() ? { fallbackHost: fallbackHost.trim() } : {}),
      ...(snapshot.serverPort ? { fallbackPort: snapshot.serverPort } : {}),
    }
    // Renderer 不持久化密码；提交后输入框立即清空。
    setWifiPassword('')
    try {
      const provisioning = window.codepulse.provisionDevice(request)
      request.wifiPassword = ''
      void provisioning.then(setSnapshot).catch(() => {
        setIpcUnavailable(true)
      })
    } catch {
      request.wifiPassword = ''
      setIpcUnavailable(true)
    }
  }

  return (
    <section className="border-t border-line pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{copy.title}</h3>
          <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.description}</p>
        </div>
        <button
          className="control-btn h-9 shrink-0 justify-center px-3"
          disabled={snapshot.scanning || active || ipcUnavailable}
          onClick={() => void window.codepulse.startDeviceScan().then(setSnapshot)}
          type="button"
        >
          {snapshot.scanning ? copy.scanning : copy.scan}
        </button>
      </div>

      {!snapshot.serverAvailable || ipcUnavailable ? (
        <p className="mt-3 rounded-badge border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          {ipcUnavailable ? copy.unavailable : copy.serverUnavailable}
        </p>
      ) : (
        <p className="mt-3 text-xs text-ink-500">
          {copy.serverReady.replace('{host}', snapshot.fallbackHost ?? '—')}
        </p>
      )}

      <div className="mt-3 grid gap-2">
        {snapshot.devices.length === 0 ? (
          <div className="rounded-badge border border-dashed border-line px-3 py-3 text-xs leading-5 text-ink-500">
            {snapshot.scanning ? copy.connectHint : copy.noDevice}
          </div>
        ) : (
          snapshot.devices.map((device) => (
            <UsbDeviceOption
              checked={device.path === selectedPath}
              copy={copy}
              device={device}
              key={device.path}
              onSelect={() => {
                setSelectedPath(device.path)
                if (device.config?.wifiSsid) setWifiSsid(device.config.wifiSsid)
              }}
            />
          ))
        )}
      </div>

      {selected && (
        <form className="mt-4 grid gap-3" onSubmit={submit}>
          <label className="grid gap-1.5 text-xs font-medium text-ink-700">
            {copy.wifiSsid}
            <input
              autoComplete="off"
              className="h-10 rounded-badge border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand-codex"
              maxLength={32}
              onChange={(event) => setWifiSsid(event.target.value)}
              required
              value={wifiSsid}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-ink-700">
            {copy.wifiPassword}
            <input
              autoComplete="new-password"
              className="h-10 rounded-badge border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand-codex"
              maxLength={64}
              onChange={(event) => setWifiPassword(event.target.value)}
              spellCheck={false}
              type="password"
              value={wifiPassword}
            />
            <span className="font-normal text-ink-500">{copy.passwordHint}</span>
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-ink-700">
            {copy.fallbackHost}
            <input
              autoComplete="off"
              className="h-10 rounded-badge border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand-codex"
              maxLength={63}
              onChange={(event) => setFallbackHost(event.target.value)}
              spellCheck={false}
              value={fallbackHost}
            />
          </label>

          <ProvisioningStatus copy={copy} displayVerified={displayVerified} snapshot={snapshot} />

          <div className="grid grid-cols-2 gap-2">
            <button
              className="control-btn h-10 justify-center"
              disabled={!active}
              onClick={() => void window.codepulse.cancelDeviceProvisioning().then(setSnapshot)}
              type="button"
            >
              {copy.cancel}
            </button>
            <button
              className="inline-flex h-10 items-center justify-center rounded-badge bg-ink px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
              disabled={!canSubmit}
              type="submit"
            >
              {active ? copy.provisioning : copy.provision}
            </button>
          </div>
          <p className="text-[11px] leading-5 text-ink-500">{copy.securityNote}</p>
        </form>
      )}
    </section>
  )
}

function UsbDeviceOption({
  checked,
  copy,
  device,
  onSelect,
}: {
  checked: boolean
  copy: DeviceProvisioningCopy
  device: CodePulseUsbDevice
  onSelect: () => void
}): JSX.Element {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-badge border px-3 py-2.5 ${
        checked ? 'border-brand-codex bg-indigo-50/70' : 'border-line bg-white'
      }`}
    >
      <input
        checked={checked}
        className="mt-1"
        name="codepulse-device"
        onChange={onSelect}
        type="radio"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{device.deviceId}</span>
        <span className="mt-0.5 block truncate text-[11px] text-ink-500">
          {device.path} · {device.firmwareVersion}
        </span>
        {device.config?.wifiSsid && (
          <span className="mt-1 block text-[11px] text-ink-500">
            {copy.configuredNetwork.replace('{ssid}', device.config.wifiSsid)}
          </span>
        )}
      </span>
    </label>
  )
}

function ProvisioningStatus({
  copy,
  displayVerified,
  snapshot,
}: {
  copy: DeviceProvisioningCopy
  displayVerified: boolean
  snapshot: DeviceProvisioningSnapshot
}): JSX.Element | null {
  const message = phaseMessage(copy, snapshot)
  if (!message) return null
  const tone =
    snapshot.phase === 'ready'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : snapshot.phase === 'error' || snapshot.phase === 'wifi_error'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-blue-200 bg-blue-50 text-blue-800'
  return (
    <p className={`rounded-badge border px-3 py-2 text-xs leading-5 ${tone}`} role="status">
      {message}
      {snapshot.phase === 'ready' && (
        <span className="block">{displayVerified ? copy.lanVerified : copy.lanWaiting}</span>
      )}
    </p>
  )
}

function phaseMessage(
  copy: DeviceProvisioningCopy,
  snapshot: DeviceProvisioningSnapshot,
): string | undefined {
  switch (snapshot.phase) {
    case 'sending':
      return copy.sending
    case 'applying':
      return copy.applying
    case 'desktop_unreachable':
      return copy.desktopUnreachable
    case 'wifi_error':
      return copy.wifiError
    case 'ready':
      return copy.ready
    case 'cancelled':
      return copy.cancelled
    case 'error':
      if (snapshot.errorCode === 'timeout') return copy.timeout
      if (snapshot.errorCode === 'invalid_input') return copy.invalidInput
      if (snapshot.errorCode === 'device_mismatch') return copy.deviceMismatch
      if (snapshot.errorCode === 'device_server_unavailable') return copy.serverUnavailable
      return copy.failed
    default:
      return undefined
  }
}

function isProvisioning(snapshot: DeviceProvisioningSnapshot): boolean {
  return (
    snapshot.phase === 'sending' ||
    snapshot.phase === 'applying' ||
    snapshot.phase === 'desktop_unreachable'
  )
}
