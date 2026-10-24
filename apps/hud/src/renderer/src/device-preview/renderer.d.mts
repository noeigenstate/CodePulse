import type { DeviceStatusV1 } from '@codepulse/shared'
export function createDeviceRenderer(bytes: BufferSource): Promise<(status: DeviceStatusV1) => Uint8Array>
export function frameToRgba(frame: Uint8Array): Uint8ClampedArray
