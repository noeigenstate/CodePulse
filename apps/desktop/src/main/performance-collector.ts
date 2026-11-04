import { cpus, freemem, totalmem, type CpuInfo } from 'node:os'
import { execFile } from 'node:child_process'

type Engine = 'cuda' | 'compute' | '3d'
type Counter = [number, Engine, number]
export interface GpuCounters {
  id: string
  name: string
  total: number
  used: number | null
  nodes: Counter[]
}
export interface GpuReading {
  id: string
  name: string
  total: number
  used: number | null
  compute: number | null
  engine: 'CUDA' | 'Compute'
  graphics: number | null
}
interface Counters {
  at: number
  cpus: CpuInfo[]
  total: number
  free: number
  gpus: GpuCounters[]
}
export interface PerformanceReading {
  model: string
  cores: (number | null)[]
  cpu: number | null
  total: number
  used: number
  gpus: GpuReading[]
}
const interval = 30_000
export const WARMUP_MS = 1200
function percentage(active: number, total: number): number | null {
  return total > 0 && active >= 0 ? Math.min(100, Math.round((100 * active) / total)) : null
}

export function readings(next: Counters, prev?: Counters): PerformanceReading {
  // Windows libuv reports irq separately even though it is already included in sys.
  const total = (t: CpuInfo['times']) =>
    t.idle + t.user + t.sys + t.nice + (process.platform === 'win32' ? 0 : t.irq)
  let elapsed = 0,
    busy = 0
  const cores = next.cpus.map(({ times, model }, index) => {
    const old = prev?.cpus[index]
    if (!old || prev?.cpus.length !== next.cpus.length || model !== old.model) return null
    const dt = total(times) - total(old.times)
    const idle = times.idle - old.times.idle
    if (dt <= 0 || idle < 0 || idle > dt) return null
    elapsed += dt
    busy += dt - idle
    return percentage(dt - idle, dt)
  })
  const gpus = next.gpus.map((gpu): GpuReading => {
    const old = prev?.gpus.find((other) => gpu.id === other.id)
    const fraction = (engine: Engine) => {
      const rates: number[] = []
      for (const [index, kind, count] of gpu.nodes) {
        if (kind !== engine || !old || !prev) continue
        const previous = old.nodes.find((n) => n[0] === index && n[1] === kind)
        if (!previous) continue
        // WDDM scheduler running time is in 100 ns ticks. Parallel engines do not add.
        const rate = percentage(count - previous[2], (next.at - prev.at) * 10000)
        if (rate !== null) rates.push(rate)
      }
      return rates.length ? Math.max(...rates) : null
    }
    const cuda = gpu.nodes.some((node) => node[1] === 'cuda')
    return {
      id: gpu.id,
      name: gpu.name,
      total: gpu.total,
      used: gpu.used,
      compute: fraction(cuda ? 'cuda' : 'compute'),
      engine: cuda ? 'CUDA' : 'Compute',
      graphics: fraction('3d'),
    }
  })
  return {
    model: next.cpus[0]?.model?.trim() ?? '',
    cores,
    cpu: percentage(busy, elapsed),
    total: next.total,
    used: Math.max(0, next.total - next.free),
    gpus,
  }
}

export function systemCounters(executable: string): () => Promise<Counters> {
  return async () => {
    const at = performance.now(),
      processors = cpus(),
      total = totalmem(),
      free = freemem()
    const gpus =
      process.platform !== 'win32'
        ? []
        : await new Promise<GpuCounters[]>((resolve) => {
            execFile(
              executable,
              [],
              { windowsHide: true, timeout: 2000, maxBuffer: 65536, encoding: 'utf8' },
              (err, output) => {
                if (err) return resolve([])
                try {
                  const raw = JSON.parse(output) as GpuCounters[]
                  resolve(
                    Array.isArray(raw)
                      ? raw.filter(
                          (g) =>
                            typeof g.id === 'string' &&
                            typeof g.name === 'string' &&
                            Array.isArray(g.nodes),
                        )
                      : [],
                  )
                } catch {
                  resolve([])
                }
              },
            )
          })
    return { at, cpus: processors, total, free, gpus }
  }
}

/** Entirely pull-driven. Concurrent previews and authenticated device reads share one sample.
 * No watchers, intervals, GPU process, or callbacks survive the last outstanding read. */
export class PerformanceCollector {
  private previous?: Counters
  private pending?: Promise<PerformanceReading | undefined>
  private nextAt = -Infinity
  latest?: PerformanceReading
  recent(): PerformanceReading | undefined {
    return this.previous && this.now() - this.previous.at < 65_000 ? this.latest : undefined
  }
  constructor(
    private read: () => Promise<Counters>,
    private now = () => performance.now(),
  ) {}
  pull(): Promise<PerformanceReading | undefined> {
    if (this.pending) return this.pending
    const at = this.now()
    if (at < this.nextAt) return Promise.resolve(this.latest)
    if (at - this.nextAt > interval) this.previous = undefined
    this.nextAt = at + (this.previous ? interval : WARMUP_MS)
    this.pending = this.read()
      .then((raw) => {
        this.latest = readings(raw, this.previous)
        this.previous = raw
        return this.latest
      })
      .catch(() => {
        this.previous = undefined
        this.latest = undefined
        this.nextAt = at + interval
        return undefined
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
}
