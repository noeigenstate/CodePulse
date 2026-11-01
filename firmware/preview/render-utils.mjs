import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

export async function planeRenderer(bytes) {
  const module = await WebAssembly.compile(bytes), wasi = Object.create(null)
  let memory
  for (const entry of WebAssembly.Module.imports(module)) {
    assert.equal(entry.module, 'wasi_snapshot_preview1')
    wasi[entry.name] = entry.name === 'random_get' ? (p, n) => {
      globalThis.crypto.getRandomValues(new Uint8Array(memory.buffer, p, n)); return 0
    } : () => { throw new Error(`Unexpected host I/O: ${entry.name}`) }
  }
  const { exports: api } = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi })
  memory = api.memory; api._initialize?.()
  return status => {
    const input = new TextEncoder().encode(JSON.stringify(status))
    assert.ok(input.length < api.preview_capacity())
    new Uint8Array(api.memory.buffer, api.preview_input(), input.length).set(input)
    assert.equal(api.preview_render(input.length, 1, 22.4, 55, 81, 1), 0)
    return { black: Buffer.from(new Uint8Array(api.memory.buffer, api.preview_frame(), 15000)),
      red: Buffer.from(new Uint8Array(api.memory.buffer, api.preview_red_frame(), 15000)) }
  }
}
export function rgbPlanes({ black, red }) {
  const rgb = Buffer.alloc(400 * 300 * 3)
  for (let i = 0; i < 120000; i++) {
    const mask = 128 >> (i & 7), byte = i >> 3
    assert.equal((black[byte] | red[byte]) & mask, mask)
    rgb.set(!(black[byte] & mask) ? [0, 0, 0] : !(red[byte] & mask) ? [190, 35, 30] : [255, 255, 255], i * 3)
  }
  return rgb
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4)
  let crc = 0xffffffff
  for (const value of body) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8)
  head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([head, body, tail])
}
export function png(rgb, width, height) {
  const header = Buffer.alloc(13), rows = Buffer.alloc((width * 3 + 1) * height)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
