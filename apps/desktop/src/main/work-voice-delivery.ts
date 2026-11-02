import { randomUUID } from 'node:crypto'
import type { UiLocale } from '@codepulse/shared'

interface Delivery {
  id: string
  text: string
  locale: UiLocale
  expiresAt: number
  valid(): boolean
  clients: Map<string, { acked: boolean; attempts: number }>
  pcm?: Promise<Uint8Array>
}

/** Short-lived work alerts, independent of assistant reminders and their cloud credentials. */
export class WorkVoiceDelivery {
  private items: Delivery[] = []
  private devices = new Map<string, number>()
  private generation = 0
  error: 'failed' | null = null
  constructor(
    private synthesize: (text: string, locale: UiLocale) => Promise<Uint8Array>,
    private changed: () => void = () => {},
    private now = Date.now,
  ) {}

  available(): boolean {
    return [...this.devices.values()].some((at) => this.now() - at < 30_000)
  }

  publish(text: string, locale: UiLocale, valid: () => boolean): void {
    this.prune()
    this.items.push({
      id: randomUUID(),
      text,
      locale,
      valid,
      expiresAt: this.now() + 120_000,
      clients: new Map(),
    })
    this.items = this.items.slice(-4)
    this.error = null
    this.changed()
  }

  claim(device: string): { id: string } | null {
    this.prune()
    for (const [id, at] of this.devices) if (this.now() - at >= 120_000) this.devices.delete(id)
    if (!this.devices.has(device) && this.devices.size >= 16) throw Error('capacity')
    const wasAvailable = this.available()
    this.devices.set(device, this.now())
    if (!wasAvailable) this.changed()
    const item = this.items.find(
      (item) => !item.clients.get(device)?.acked && (item.clients.get(device)?.attempts ?? 0) < 3,
    )
    if (!item) return null
    if (!item.clients.has(device)) item.clients.set(device, { acked: false, attempts: 0 })
    return { id: item.id }
  }

  async audio(device: string, id: string): Promise<Uint8Array> {
    this.prune()
    const item = this.items.find((item) => item.id === id)
    const lease = item?.clients.get(device)
    if (!item || !lease || lease.acked || lease.attempts >= 3) throw Error('expired')
    lease.attempts++
    const generation = this.generation
    try {
      item.pcm ??= this.synthesize(item.text, item.locale)
      const pcm = await item.pcm
      if (generation !== this.generation || !item.valid() || this.now() >= item.expiresAt)
        throw Error('expired')
      if (pcm.byteLength < 3200 || pcm.byteLength > 640000 || pcm.byteLength % 2)
        throw Error('format')
      return pcm
    } catch (error) {
      if (generation === this.generation && (error as Error).message !== 'expired') {
        this.error = 'failed'
        this.changed()
      }
      throw error
    }
  }

  acknowledge(device: string, id: string): void {
    this.prune()
    const lease = this.items.find((item) => item.id === id)?.clients.get(device)
    if (!lease || lease.attempts < 1) throw Error('expired')
    lease.acked = true
  }

  clear(): void {
    this.generation++
    this.items = []
    this.error = null
    this.changed()
  }
  private prune(): void {
    this.items = this.items.filter((item) => item.valid() && this.now() < item.expiresAt)
  }
}
