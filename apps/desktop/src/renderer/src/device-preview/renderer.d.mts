import type { DeviceStatusV1 } from '@codepulse/shared'
/** Black plane and red plane, 15000 bytes each in canvas format (red bit 0 = red pigment). */
export interface DevicePlanes {
  black: Uint8Array
  red: Uint8Array
}
export function createDevicePlaneRenderer(bytes: BufferSource): Promise<(status: DeviceStatusV1) => DevicePlanes>
export function createDeviceRenderer(bytes: BufferSource): Promise<(status: DeviceStatusV1) => Uint8Array>
export function frameToRgba(frame: Uint8Array): Uint8ClampedArray
export function planesToRgba(black: Uint8Array, red: Uint8Array): Uint8ClampedArray
