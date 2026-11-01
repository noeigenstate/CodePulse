// Node 24: node preview/render-pets.mjs renderer.wasm ambient-pet-art.ts output-dir
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
const [wasm, art, output] = process.argv.slice(2).map(p => resolve(p))
const { renderPetArt } = await import(pathToFileURL(art))
const module = await WebAssembly.compile(readFileSync(wasm)), wasi = Object.create(null)
let memory
for (const entry of WebAssembly.Module.imports(module)) {
  assert.equal(entry.module, 'wasi_snapshot_preview1')
  wasi[entry.name] = entry.name === 'random_get' ? (p, n) => {
    globalThis.crypto.getRandomValues(new Uint8Array(memory.buffer, p, n)); return 0
  } : () => { throw new Error(`Unexpected host I/O: ${entry.name}`) }
}
const { exports: api } = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi })
memory = api.memory; api._initialize?.()
const moods = ['idle', 'working', 'hungry', 'happy', 'sleepy']
const pets = [
  ['tuantuan', '团团', ['我在晒太阳，你忙你的。', '你敲你的，我替你盯着。', '额度见底了……能续点口粮吗？', '搞定啦！今晚的小鱼干有着落了。', '夜深了，我先窝着，晚安。']],
  ['yaya', '芽芽', ['我在长高，你也慢慢来。', '戴上眼镜，陪你一起看。', '叶子耷拉了，浇点额度吧。', '你又长出一片新叶子！', '光合作用暂停，明早见。']],
  ['fangfang', '方方', ['系统待机，心情平稳。', 'Agent 在跑，我在旁边待命。', '电量告急，求一格额度。', '任务完成，开心指数 100%。', '进入夜间模式，晚安。']],
  ['rongrong', '绒绒', ['尾巴摇一摇，心情不错。', '我只是路过，没偷看哦。', '额度见底啦，借我点呗？', '搞定！我早就猜到了。', '夜深了，尾巴盖好睡啦。']],
  ['lulu', '噜噜', ['吃饱喝足，晒晒太阳。', '你忙你的，我在旁边哼哼。', '肚子咕噜，额度见底了。', '搞定啦！今晚加个餐。', '呼噜噜……先睡一会儿。']]
]
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
function png(rgb, width, height) {
  const header = Buffer.alloc(13), rows = Buffer.alloc((width * 3 + 1) * height)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
mkdirSync(output, { recursive: true })
const overview = Buffer.alloc(2000 * pets.length * 300 * 3, 255), captions = []
for (const [row, [id, name, lines]] of pets.entries()) for (const [col, mood] of moods.entries()) {
  const status = { protocolVersion: 1, revision: 'pet-layout-gallery', mainState: 'idle', agents: [],
    display: { version: 1, mode: 'hud', metric: 'remaining', showQuota: true, showEnvironment: true,
      agents: ['codex', 'claude_code', 'grok'], page: 0 }, threadTotal: 0, threads: [],
    ambient: { id: `pet:${row}:${mood}:1030`, source: `像素宠物 · ${name}`,
      text: lines[col], layout: 'pet', ...renderPetArt(id, mood) } }
  const input = new TextEncoder().encode(JSON.stringify(status))
  assert.ok(input.length < 32000)
  new Uint8Array(api.memory.buffer, api.preview_input(), input.length).set(input)
  assert.equal(api.preview_render(input.length, 1, 22.4, 55, 81, 1), 0)
  const black = Buffer.from(new Uint8Array(api.memory.buffer, api.preview_frame(), 15000))
  const red = Buffer.from(new Uint8Array(api.memory.buffer, api.preview_red_frame(), 15000))
  const rgb = Buffer.alloc(400 * 300 * 3)
  for (let i = 0; i < 120000; i++) {
    const mask = 128 >> (i & 7), byte = i >> 3
    assert.equal((black[byte] | red[byte]) & mask, mask)
    const color = !(black[byte] & mask) ? [0, 0, 0] : !(red[byte] & mask) ? [190, 35, 30] : [255, 255, 255]
    rgb.set(color, i * 3)
  }
  const file = `${id}-${mood}`
  writeFileSync(join(output, file + '.json'), JSON.stringify(status, null, 2) + '\n')
  writeFileSync(join(output, file + '.black.bin'), black); writeFileSync(join(output, file + '.red.bin'), red)
  writeFileSync(join(output, file + '.png'), png(rgb, 400, 300))
  for (let y = 0; y < 300; y++) rgb.copy(overview, ((row * 300 + y) * 2000 + col * 400) * 3, y * 1200, (y + 1) * 1200)
  captions.push({ pet: name, mood, text: lines[col], file: file + '.png' })
}
writeFileSync(join(output, 'overview.png'), png(overview, 2000, pets.length * 300))
writeFileSync(join(output, 'captions.json'), JSON.stringify(captions, null, 2) + '\n')
writeFileSync(join(output, 'lines.txt'), captions.map(c => c.text).join('\n') + '\n')
console.log(`PASS: ${pets.length * moods.length} real pet scenes; 400x300 PNGs and native-size gallery`)
