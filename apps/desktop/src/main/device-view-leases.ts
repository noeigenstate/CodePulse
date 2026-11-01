/** A view may release only the shared resources it requested. */
export class DeviceViewLeases {
  private scanning = new Set<number>()
  private provisioning: number | undefined
  constructor(
    private scan: (active: boolean) => void,
    private cancel: () => void,
  ) {}
  start(id: number): void {
    const first = this.scanning.size === 0
    this.scanning.add(id)
    if (first && this.provisioning === undefined) this.scan(true)
  }
  stop(id: number): void {
    if (this.scanning.delete(id) && !this.scanning.size) this.scan(false)
  }
  claim(id: number): boolean {
    if (this.provisioning !== undefined) return false
    this.provisioning = id
    this.scan(false)
    return true
  }
  finish(id: number): void {
    if (this.provisioning !== id) return
    this.provisioning = undefined
    if (this.scanning.size) this.scan(true)
  }
  cancelFor(id: number): boolean {
    if (this.provisioning !== id) return false
    this.cancel()
    return true
  }
  release(id: number): void {
    this.stop(id)
    this.cancelFor(id)
  }
}
