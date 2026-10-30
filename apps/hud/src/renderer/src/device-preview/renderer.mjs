// Only the C/Wasm module lays out text or chooses pixels. Do not duplicate any
// firmware layout, font metrics, quota selection or protocol mapping here.
export async function createDevicePlaneRenderer(bytes) {
  const module = await WebAssembly.compile(bytes)
  // libc's unused I/O paths may remain linked. No host capabilities are granted.
  const wasi = Object.create(null)
  let memory
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.module !== 'wasi_snapshot_preview1' || entry.kind !== 'function') {
      throw new Error('Unexpected renderer import')
    }
    // libc initializes its stack canary from entropy. No filesystem, network,
    // environment, serial, clock or configuration access is provided.
    wasi[entry.name] = entry.name === 'random_get' ? (pointer, length) => {
      if (length > 65536 || pointer < 0 || pointer + length > memory.buffer.byteLength) return 21
      globalThis.crypto.getRandomValues(new Uint8Array(memory.buffer, pointer, length))
      return 0
    } : () => { throw new Error(`The display renderer cannot use host I/O: ${entry.name}`) }
  }
  const { exports: api } = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi })
  memory = api.memory
  api._initialize?.()
  const encoder = new TextEncoder()
  const hasRed = typeof api.preview_red_frame === 'function'
  return function render(status) {
    const input = encoder.encode(JSON.stringify(status))
    if (input.length >= api.preview_capacity()) throw new Error('Display data exceeds renderer capacity')
    new Uint8Array(api.memory.buffer, api.preview_input(), input.length).set(input)
    // Sensor values and connection telemetry are not in the desktop protocol.
    // Render the actual firmware's unknown state instead of inventing readings.
    if (api.preview_render(input.length, 0, 0, 0, -1, 0) !== 0) throw new Error('Invalid display data')
    if (api.preview_size() !== 15000) throw new Error('Unexpected display size')
    const black = new Uint8Array(api.memory.buffer, api.preview_frame(), api.preview_size()).slice()
    // Older renderer builds have no red plane: every bit set means no red pigment anywhere.
    const red = hasRed
      ? new Uint8Array(api.memory.buffer, api.preview_red_frame(), 15000).slice()
      : new Uint8Array(15000).fill(0xff)
    return { black, red }
  }
}

export async function createDeviceRenderer(bytes) {
  const render = await createDevicePlaneRenderer(bytes)
  return (status) => render(status).black
}

export function frameToRgba(frame) {
  if (frame.length !== 15000) throw new Error('Invalid frame size')
  const rgba = new Uint8ClampedArray(400 * 300 * 4)
  for (let i = 0; i < 400 * 300; i++) {
    const value = frame[i >> 3] & (0x80 >> (i & 7)) ? 255 : 0
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = value
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

// Panel red in the same family as the physical pigment: dark enough to stay distinct from black ink on a white page.
const PANEL_RED = [190, 30, 45]

// Both planes use the canvas format. Black plane: 1 = paper, 0 = black ink. Red plane: 0 = red pigment.
// A pixel is red only where the black plane left paper, so black always wins, as on the device.
export function planesToRgba(black, red) {
  if (black.length !== 15000 || red.length !== 15000) throw new Error('Invalid frame size')
  const rgba = new Uint8ClampedArray(400 * 300 * 4)
  for (let i = 0; i < 400 * 300; i++) {
    const mask = 0x80 >> (i & 7)
    const paper = black[i >> 3] & mask
    const isRed = paper && !(red[i >> 3] & mask)
    const value = paper ? 255 : 0
    rgba[i * 4] = isRed ? PANEL_RED[0] : value
    rgba[i * 4 + 1] = isRed ? PANEL_RED[1] : value
    rgba[i * 4 + 2] = isRed ? PANEL_RED[2] : value
    rgba[i * 4 + 3] = 255
  }
  return rgba
}
