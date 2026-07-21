/** `_codepulse._tcp.local` Desktop 设备 API 发布器。 */
import Bonjour from 'bonjour-service'
import { DEVICE_PROTOCOL_VERSION } from '@codepulse/shared'

export const DEVICE_MDNS_TYPE = 'codepulse'
export const DEVICE_MDNS_PROTOCOL = 'tcp' as const

interface MdnsInstance {
  publish(options: {
    name: string
    type: string
    protocol: 'tcp'
    port: number
    txt: Record<string, string>
  }): ServiceLike
  destroy: CallableFunction
}

interface ServiceLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  stop: CallableFunction
}

export interface DeviceMdnsPublisherOptions {
  serverId: string
  port: number
  statusPath: string
  mdns?: MdnsInstance
  onError?: (message: string) => void
}

/** 一个已发布、可幂等关闭的 Desktop mDNS 服务。 */
export interface DeviceMdnsPublisher {
  serverId: string
  port: number
  txt: Readonly<Record<string, string>>
  close: () => Promise<void>
}

/**
 * 发布 Desktop 服务。TXT 有意只包含协议、配对身份和只读状态路径；
 * token、用户名与本机路径永远不会进入广播。
 */
export function publishDeviceMdns(options: DeviceMdnsPublisherOptions): DeviceMdnsPublisher {
  const mdns =
    options.mdns ??
    (new Bonjour(undefined, (error: unknown) =>
      options.onError?.(safeMdnsError(error)),
    ) as unknown as MdnsInstance)
  const txt = Object.freeze({
    pv: String(DEVICE_PROTOCOL_VERSION),
    id: options.serverId,
    path: options.statusPath,
  })
  let service: ServiceLike
  try {
    service = mdns.publish({
      name: `CodePulse-${options.serverId.slice(0, 8)}`,
      type: DEVICE_MDNS_TYPE,
      protocol: DEVICE_MDNS_PROTOCOL,
      port: options.port,
      txt,
    })
  } catch (error) {
    if (!options.mdns) {
      try {
        mdns.destroy()
      } catch {
        // Constructor succeeded but publishing failed; best-effort transport cleanup.
      }
    }
    throw error
  }
  service.on('error', (error) => options.onError?.(safeMdnsError(error)))

  let closing: Promise<void> | undefined
  return {
    serverId: options.serverId,
    port: options.port,
    txt,
    close: () => {
      if (closing) return closing
      closing = stopService(service).finally(() => {
        try {
          mdns.destroy()
        } catch {
          // Socket may already be closed after an mDNS transport error.
        }
      })
      return closing
    },
  }
}

function stopService(service: ServiceLike): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(finish, 1_000)
    timeout.unref?.()
    try {
      service.stop(finish)
    } catch {
      finish()
    }
  })
}

function safeMdnsError(error: unknown): string {
  return error instanceof Error ? error.message : 'mDNS transport error'
}
