/**
 * Debounce window-focus refreshes into one asynchronous session scan.
 *
 * Tray clicks, Electron focus events and renderer bootstrap can arrive almost at
 * once. Every caller receives a promise for the same scan instead of starting a
 * stack of full disk reads.
 *
 * @module desktop/main/focus-sync
 */

interface SyncWaiter {
  reject: (reason?: unknown) => void
  resolve: () => void
}

/**
 * Coalesces focus-triggered disk refreshes without dropping caller completion signals.
 *
 * Requests inside one debounce window share one scan. Requests received while
 * that scan runs become exactly one trailing scan; each returned promise resolves
 * or rejects with the scan batch that owns it.
 */
export class FocusSyncScheduler {
  private timer?: NodeJS.Timeout
  private running = false
  private waiters: SyncWaiter[] = []

  constructor(
    private readonly sync: () => void | Promise<void>,
    private readonly debounceMs: number,
  ) {}

  /**
   * Queues a focus refresh and returns the promise for its coalesced scan batch.
   *
   * @returns A promise that settles when this request's scan has completed.
   */
  schedule(): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
    this.arm()
    return result
  }

  /**
   * Cancels only a not-yet-started scan during app shutdown.
   *
   * Queued callers resolve because shutdown intentionally abandons their refresh;
   * an already-running sync is not interrupted.
   */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.resolve()
  }

  /** Restarts the debounce timer for the current queued batch. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /** Runs the current batch, or schedules a trailing batch when a scan is active. */
  private async flush(): Promise<void> {
    // A focus event received during an active scan becomes one trailing scan.
    if (this.running) {
      this.arm()
      return
    }

    const waiters = this.waiters.splice(0)
    if (waiters.length === 0) return

    this.running = true
    try {
      await this.sync()
      for (const waiter of waiters) waiter.resolve()
    } catch (err) {
      for (const waiter of waiters) waiter.reject(err)
    } finally {
      this.running = false
      if (this.waiters.length > 0 && !this.timer) this.arm()
    }
  }
}
