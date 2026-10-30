import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  AMBIENT_RED_MAX_BYTES,
  DEFAULT_AMBIENT,
  PET_IDS,
  PET_MOODS,
  PET_PROFILES,
  normalizeAmbient,
  petMoodLabel,
  petProfile,
  type AmbientCard,
  type AmbientRedPlane,
  type PetId,
  type PetMood,
  type StatusSnapshot,
} from '@codepulse/shared'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { PET_LINES, petCards, petMood } from '../apps/desktop/src/main/ambient-pet.js'
import { renderPetArt } from '../apps/desktop/src/main/ambient-pet-art.js'
import {
  contentKey,
  deviceCard,
  qualifies,
  withAmbient,
} from '../apps/desktop/src/main/ambient-rules.js'
import {
  createDevicePlaneRenderer as desktopPlanes,
  createDeviceRenderer as desktopRenderer,
  planesToRgba,
} from '../apps/desktop/src/renderer/src/device-preview/renderer.mjs'

const at = (hour: number, minute = 0) => new Date(2026, 9, 29, hour, minute).getTime()
const noon = at(12)
type AgentOverrides = Partial<StatusSnapshot['agents'][number]>
const status = (...agents: AgentOverrides[]): StatusSnapshot =>
  ({
    overall: 'idle',
    updatedAt: noon,
    agents: agents.map((a) => ({
      agentType: 'codex',
      state: 'IDLE',
      unread: false,
      needPermission: false,
      needUserInput: false,
      toolCallCount: 0,
      lastEventAt: 0,
      ...a,
    })),
  }) as StatusSnapshot
const quota = (usedPercent: number, resetsAt?: number): AgentOverrides => ({
  token: { accuracy: 'exact', rateLimits: { fiveHour: { usedPercent, resetsAt } } },
})
const petConfig = (overrides = {}) =>
  normalizeAmbient({ ...DEFAULT_AMBIENT, enabled: true, ...overrides })

test('pet mood: night, hunger, work, afterglow and idle follow the documented priority', () => {
  assert.equal(petMood(status(), noon), 'idle')
  assert.equal(petMood(status({ state: 'THINKING' }), noon), 'working')
  assert.equal(petMood(status({ state: 'PROMPT_SUBMITTED' }), noon), 'working')
  assert.equal(petMood(status({ state: 'TOOL_RUNNING' }), noon), 'working')
  // Waiting for the user is not "working"; the desk needs the person, not the pet.
  assert.equal(petMood(status({ state: 'WAITING_PERMISSION' }), noon), 'idle')
  assert.equal(petMood(status({ state: 'DONE', terminalAt: noon - 3600000 }), noon), 'happy')
  assert.equal(petMood(status({ state: 'DONE', terminalAt: noon - 2 * 3600000 }), noon), 'happy')
  assert.equal(petMood(status({ state: 'DONE', terminalAt: noon - 2 * 3600000 - 1 }), noon), 'idle')
  assert.equal(petMood(status({ state: 'DONE' }), noon), 'idle', 'DONE without a time is not fresh')
  assert.equal(petMood(status({ state: 'ERROR', terminalAt: noon - 1000 }), noon), 'idle')
  // Active work outranks the afterglow of an older finish.
  assert.equal(
    petMood(status({ state: 'DONE', terminalAt: noon - 1000 }, { state: 'THINKING' }), noon),
    'working',
  )
  assert.equal(petMood(status({ state: 'THINKING', taskHidden: true }), noon), 'idle')
})
test('pet mood: 80% used (20% left) is hungry, a reset window is ignored', () => {
  assert.equal(petMood(status(quota(79)), noon), 'idle')
  assert.equal(petMood(status(quota(80)), noon), 'hungry')
  assert.equal(petMood(status(quota(100)), noon), 'hungry')
  assert.equal(petMood(status(quota(95, noon / 1000 - 5)), noon), 'idle', 'window already reset')
  assert.equal(petMood(status(quota(95, noon / 1000 + 600)), noon), 'hungry')
  assert.equal(
    petMood(
      status({
        token: {
          accuracy: 'exact',
          quotaBuckets: { spark: { rateLimits: { sevenDay: { usedPercent: 85 } } } },
        },
      }),
      noon,
    ),
    'hungry',
  )
  assert.equal(petMood(status(quota(Number.NaN)), noon), 'idle')
  // Hunger beats work and afterglow.
  assert.equal(petMood(status({ ...quota(90), state: 'THINKING' }), noon), 'hungry')
})
test('pet mood: 23:00-06:59 local time is sleepy whatever else is happening', () => {
  const busy = status({ ...quota(95), state: 'THINKING' })
  for (const hour of [23, 0, 3, 6])
    assert.equal(petMood(busy, at(hour, 30)), 'sleepy', String(hour))
  assert.equal(petMood(busy, at(22, 59)), 'hungry')
  assert.equal(petMood(status(), at(7, 0)), 'idle')
  assert.equal(petMood(status(), at(22, 59)), 'idle')
})

function bits(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}
const bitAt = (bytes: Uint8Array, index: number) =>
  (bytes[index >> 3]! & (0x80 >> (index & 7))) !== 0
/** Every rule of the wire contract for one red rectangle. */
function assertValidRed(red: AmbientRedPlane, imageHex: string) {
  assert.ok(Number.isInteger(red.x) && Number.isInteger(red.y), 'integer origin')
  assert.equal(red.x % 8, 0)
  assert.equal(red.w % 8, 0)
  assert.ok(red.w >= 8 && red.h >= 1)
  assert.ok(red.x + red.w <= 384 && red.y + red.h <= 208, 'inside the picture area')
  assert.ok((red.w * red.h) / 8 <= AMBIENT_RED_MAX_BYTES, `${(red.w * red.h) / 8} bytes`)
  assert.equal(red.hex.length, (red.w * red.h) / 4)
  assert.match(red.hex, /^[0-9a-fA-F]+$/)
  const black = bits(imageHex),
    ink = bits(red.hex)
  let redPixels = 0
  for (let row = 0; row < red.h; row++)
    for (let col = 0; col < red.w; col++)
      if (bitAt(ink, row * red.w + col)) {
        redPixels++
        assert.equal(
          bitAt(black, (red.y + row) * 384 + red.x + col),
          false,
          'red never overlaps black',
        )
      }
  assert.ok(redPixels > 0, 'rectangle holds red ink')
}
test('every pet in every mood is a valid 384x208 bitmap with a legal, tight red rectangle', () => {
  assert.deepEqual([...PET_IDS], ['tuantuan', 'yaya', 'fangfang'])
  const seen = new Set<string>()
  for (const id of PET_IDS)
    for (const mood of PET_MOODS) {
      const art = renderPetArt(id, mood)
      assert.equal(art.imageHex.length, 19968, `${id}/${mood}`)
      assert.match(art.imageHex, /^[0-9a-f]+$/)
      const ink = bits(art.imageHex).reduce((n, b) => n + b.toString(2).replace(/0/g, '').length, 0)
      assert.ok(ink > 800 && ink < 20000, `${id}/${mood} ink ${ink}`)
      assert.ok(art.red, `${id}/${mood} keeps its cheeks`)
      assertValidRed(art.red!, art.imageHex)
      seen.add(art.imageHex)
      // Cached: the same object comes back.
      assert.equal(renderPetArt(id, mood), art)
    }
  assert.equal(
    seen.size,
    PET_IDS.length * PET_MOODS.length,
    'moods and pets are all distinguishable',
  )
})
test('pet lines are short, friendly and complete', () => {
  for (const id of PET_IDS)
    for (const mood of PET_MOODS) {
      const line = PET_LINES[id][mood]
      assert.ok(line.length > 0 && [...line].length <= 20, `${id}/${mood}: ${line}`)
    }
})
test('pet cards: one per pet, id carries pet, mood and local date, art matches the mood', () => {
  const cards = petCards(status(quota(95)), noon)
  assert.deepEqual(
    cards.map((c) => c.id),
    PET_IDS.map((id) => `pet:${id}:hungry:2026-10-29`),
  )
  for (const c of cards) {
    assert.equal(c.kind, 'pet')
    assert.match(c.source, /^像素宠物 · .+/)
    assert.equal(c.text, PET_LINES[c.pet!.id][c.pet!.mood])
    assert.equal(c.imageHex, renderPetArt(c.pet!.id, 'hungry').imageHex)
    assert.deepEqual(c.red, renderPetArt(c.pet!.id, 'hungry').red)
    assert.ok(c.publishedAt <= noon && c.expiresAt > noon)
  }
  assert.equal(petCards(status(), at(1))[0]!.id, 'pet:tuantuan:sleepy:2026-10-29')
})

test('pet cards ask for the pet layout and only a bitmap card passes it on to the device', () => {
  const cards = petCards(status(), noon)
  assert.ok(cards.every((c) => c.layout === 'pet'))
  const card = cards[0]!
  assert.equal(deviceCard(card).layout, 'pet')
  assert.equal(deviceCard({ ...card, imageHex: undefined, red: undefined }).layout, undefined)
  assert.equal(deviceCard({ ...card, layout: undefined }).layout, undefined)
  assert.equal('layout' in deviceCard({ ...card, kind: 'note', layout: undefined }), false)
  const base = toDeviceStatusV1(new StatusHub().snapshot())
  assert.equal(withAmbient(base, card).ambient!.layout, 'pet')
  assert.notEqual(
    withAmbient(base, card).revision,
    withAmbient(base, { ...card, layout: undefined }).revision,
    'a layout change is a new revision',
  )
  assert.notEqual(contentKey(card), contentKey({ ...card, layout: undefined }))
})
test('device ambient id follows the picture, so a changed layout or bitmap is redrawn', () => {
  const card = petCards(status(), noon)[0]!
  const id = (c: AmbientCard) => deviceCard(c).id
  assert.match(id(card), /^[0-9a-f]{24}$/)
  assert.equal(id(card), id({ ...card }), 'identical card, stable id')
  assert.notEqual(id(card), id({ ...card, layout: undefined }), 'layout only')
  const flipped = card.imageHex!.slice(0, -1) + (card.imageHex!.endsWith('0') ? '1' : '0')
  assert.notEqual(id(card), id({ ...card, imageHex: flipped }), 'bitmap only')
  const red = card.red!
  const redFlipped = red.hex.slice(0, -1) + (red.hex.endsWith('0') ? '1' : '0')
  assert.notEqual(id(card), id({ ...card, red: { ...red, hex: redFlipped } }), 'red only')
  assert.notEqual(id(card), id({ ...card, red: undefined }), 'red removed')
  // Cards without a bitmap keep the plain hash of the card id.
  const note: AmbientCard = { ...card, imageHex: undefined, red: undefined, layout: undefined }
  assert.equal(id(note), id({ ...note, layout: 'pet' }))
})

const petCard = (over: Partial<AmbientCard> = {}): AmbientCard => ({
  ...petCards(status(), noon).find((c) => c.pet!.id === 'tuantuan')!,
  ...over,
})
test('qualifies: pets obey the master switch and only the chosen pet may be pushed', () => {
  const card = petCard()
  assert.equal(qualifies(card, petConfig(), noon), true)
  assert.equal(qualifies(card, petConfig({ petEnabled: false }), noon), false)
  assert.equal(qualifies(card, petConfig({ petId: 'yaya' }), noon), false)
  assert.equal(qualifies({ ...card, pet: undefined }, petConfig(), noon), false)
  assert.equal(qualifies({ ...card, expiresAt: noon }, petConfig(), noon), false)
  // The pet branch must not fall through to the X rules.
  assert.equal(
    qualifies(
      { ...card, score: 0, source: '像素宠物 · 团团' },
      petConfig({ xEnabled: false }),
      noon,
    ),
    true,
  )
})
test('contentKey sees red ink and gives each day its own pet key', () => {
  const card = petCard()
  const redless = { ...card, red: undefined }
  assert.notEqual(contentKey(card), contentKey(redless))
  const moved = { ...card, red: { ...card.red!, x: card.red!.x + 8 } }
  assert.notEqual(contentKey(card), contentKey(moved))
  assert.notEqual(contentKey(card), contentKey({ ...card, id: 'pet:tuantuan:idle:2026-10-30' }))
  assert.equal(contentKey(card), contentKey({ ...card }))
  // Existing kinds hash exactly as before when they have no red.
  const x: AmbientCard = { ...card, kind: 'x', red: undefined, id: 'x:1' }
  assert.equal(contentKey(x), contentKey({ ...x, id: 'x:2' }))
})
test('deviceCard passes red through untouched and only for bitmap cards', () => {
  const card = petCard()
  const device = deviceCard(card)
  assert.deepEqual(device.red, card.red)
  assert.equal(device.imageHex, card.imageHex)
  assert.equal(device.source, card.source)
  assert.equal(deviceCard({ ...card, imageHex: undefined }).red, undefined)
  assert.equal(deviceCard({ ...card, red: undefined }).red, undefined)
  assert.equal('red' in deviceCard({ ...card, red: undefined }), false)
})
test('withAmbient sheds the red plane first, then the bitmap, and keeps the budget', () => {
  const base = toDeviceStatusV1(new StatusHub().snapshot())
  const card = petCard()
  const full = withAmbient(base, card)
  assert.deepEqual(full.ambient?.red, card.red)
  const size = (s: unknown) => Buffer.byteLength(JSON.stringify(s))
  assert.ok(size(full) <= 32000)
  const withMessage = (n: number) => ({ ...base, message: 'x'.repeat(n) })
  const blackOnlySize = size(withAmbient(withMessage(0), { ...card, red: undefined }))
  assert.ok(size(withAmbient(withMessage(0), card)) > blackOnlySize + 200, 'red adds real bytes')
  const tight = withMessage(32000 - blackOnlySize - 10)
  const reduced = withAmbient(tight, card)
  assert.ok(reduced.ambient, 'bitmap survives')
  assert.equal(reduced.ambient!.imageHex, card.imageHex)
  assert.equal(reduced.ambient!.red, undefined)
  assert.ok(size(reduced) <= 32000)
  assert.notEqual(reduced.revision, full.revision)
  // No room even for the picture: plain work status.
  const crowded = { ...base, message: 'x'.repeat(22000) }
  assert.equal(withAmbient(crowded, card), crowded)
  // The red rectangle belongs to the revision.
  assert.notEqual(
    withAmbient(base, card).revision,
    withAmbient(base, { ...card, red: undefined }).revision,
  )
})
test('normalizeAmbient validates the pet settings', () => {
  assert.equal(DEFAULT_AMBIENT.petEnabled, true)
  assert.equal(DEFAULT_AMBIENT.petId, 'tuantuan')
  assert.equal(normalizeAmbient(null).petEnabled, true)
  assert.equal(normalizeAmbient({}).petId, 'tuantuan')
  assert.equal(normalizeAmbient({ petEnabled: false }).petEnabled, false)
  assert.equal(normalizeAmbient({ petEnabled: 'no' }).petEnabled, true)
  for (const id of PET_IDS) assert.equal(normalizeAmbient({ petId: id }).petId, id)
  for (const bad of ['', 'dragon', 7, null, ['yaya'], { id: 'yaya' }])
    assert.equal(normalizeAmbient({ petId: bad }).petId, 'tuantuan')
})

function petService(initial: StatusSnapshot, overrides = {}) {
  let now = noon,
    current = initial
  const service = new AmbientService({
    config: {
      ...petConfig(),
      ...overrides,
      conceptsEnabled: false,
      xEnabled: false,
      memeEnabled: false,
    },
    now: () => now,
    status: () => current,
    key: () => '',
    save: () => undefined,
    request: async () => ({}),
    image: async () => '',
    changed: () => undefined,
  })
  return {
    service,
    set: (s: StatusSnapshot) => {
      current = s
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}
test('service lists all pets, pushes only the chosen one and freezes the shown card', () => {
  const f = petService(status())
  const pets = () => f.service.snapshot().cards.filter((c) => c.kind === 'pet')
  assert.equal(pets().length, 3)
  f.service.show('pet:yaya:idle:2026-10-29')
  assert.equal(f.service.current(), undefined, 'a pet that is not chosen is never pushed')
  f.service.show()
  const shown = f.service.current()!
  assert.equal(shown.id, 'pet:tuantuan:idle:2026-10-29')
  assert.ok(shown.imageHex && shown.red)
  // Live status changes the offered cards but never the card on screen.
  f.set(status(quota(95)))
  assert.ok(pets().every((c) => c.pet!.mood === 'hungry'))
  assert.equal(f.service.current()?.id, shown.id)
  assert.equal(f.service.snapshot().activeId, shown.id)
  assert.deepEqual(f.service.current()?.red, shown.red)
  // Once seen today, the same pet and mood are not pushed again.
  f.service.dismiss()
  f.advance(10 * 3600000 - 60000 * 600)
  f.set(status())
  f.service.show()
  assert.equal(f.service.current(), undefined)
})
test('service: pets switched off are never pushed but can still be shown by hand', () => {
  const f = petService(status(), { petEnabled: false })
  f.service.show()
  assert.equal(f.service.current(), undefined)
  f.service.showManual('pet:fangfang:idle:2026-10-29')
  assert.equal(f.service.current()?.manual, true)
  assert.equal(f.service.current()?.pet?.id, 'fangfang')
})

test('planesToRgba paints red only on paper pixels, black always wins', () => {
  const black = new Uint8Array(15000).fill(0xff),
    red = new Uint8Array(15000).fill(0xff)
  black[0] = 0x7f // pixel 0 is black ink
  red[0] = 0x3f // pixels 0 and 1 carry red pigment; pixel 0 sits on black
  const rgba = planesToRgba(black, red)
  assert.equal(rgba.length, 400 * 300 * 4)
  assert.deepEqual([...rgba.slice(0, 4)], [0, 0, 0, 255], 'black wins over red')
  assert.deepEqual([...rgba.slice(4, 8)], [190, 30, 45, 255], 'red on paper')
  assert.deepEqual([...rgba.slice(8, 12)], [255, 255, 255, 255], 'paper')
  assert.deepEqual([...rgba.slice(28, 32)], [255, 255, 255, 255], 'last pixel of the byte')
  const noRed = planesToRgba(black, new Uint8Array(15000).fill(0xff))
  assert.deepEqual([...noRed.slice(4, 8)], [255, 255, 255, 255])
  assert.throws(() => planesToRgba(new Uint8Array(10), red))
  assert.throws(() => planesToRgba(black, new Uint8Array(10)))
})
test('plane renderer keeps the black plane and falls back to no red on older Wasm', async () => {
  const bytes = new Uint8Array(
    readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm'),
  )
  const planes = await desktopPlanes(bytes)
  const blackOnly = await desktopRenderer(bytes)
  const input = withAmbient(
    toDeviceStatusV1(new StatusHub().snapshot()),
    petCards(status(), noon).find((c) => c.pet!.id === 'yaya')!,
  )
  const frame = planes(input)
  assert.equal(frame.black.length, 15000)
  assert.equal(frame.red.length, 15000)
  assert.deepEqual(frame.black, blackOnly(input))
  assert.ok(
    frame.black.some((v) => v !== 0xff),
    'the picture is drawn',
  )
  // The checked-in Wasm may predate preview_red_frame; then nothing is red.
  const hasRedExport = WebAssembly.Module.exports(await WebAssembly.compile(bytes)).some(
    (e) => e.name === 'preview_red_frame',
  )
  if (!hasRedExport) assert.ok(frame.red.every((v) => v === 0xff))
})
test('desktop and HUD preview adapters stay byte-identical', () => {
  for (const file of ['renderer.mjs', 'renderer.d.mts'])
    assert.deepEqual(
      readFileSync('apps/desktop/src/renderer/src/device-preview/' + file),
      readFileSync('apps/hud/src/renderer/src/device-preview/' + file),
      file,
    )
})
test('PetId and PetMood stay in sync with the art tables', () => {
  const ids: PetId[] = [...PET_IDS]
  const moods: PetMood[] = [...PET_MOODS]
  for (const id of ids) assert.deepEqual(Object.keys(PET_LINES[id]).sort(), [...moods].sort())
})

test('a host that predates the pet settings, or sends junk, never leaves the page without a pet', () => {
  // Root cause of the 多媒体玩法 crash: the page indexed PET_PROFILES with an id that was not
  // there (a config without petId, or an unknown id) and read `.name` of undefined.
  const legacy = { ...DEFAULT_AMBIENT } as Record<string, unknown>
  delete legacy.petId
  delete legacy.petEnabled
  const config = normalizeAmbient(legacy)
  assert.equal(config.petId, 'tuantuan')
  assert.equal(config.petEnabled, true)
  assert.equal(petProfile(undefined).name, PET_PROFILES.tuantuan.name)
  assert.equal(petProfile('dragon').name, PET_PROFILES.tuantuan.name)
  assert.equal(petProfile(null).name, PET_PROFILES.tuantuan.name)
  assert.equal(petProfile('yaya').name, PET_PROFILES.yaya.name)
  assert.equal(petProfile('__proto__').name, PET_PROFILES.tuantuan.name)
  assert.equal(petMoodLabel(undefined).label, petMoodLabel('idle').label)
  assert.equal(petMoodLabel('hungry').label, '饿了')
  assert.equal(petMoodLabel('constructor').label, petMoodLabel('idle').label)
  for (const id of PET_IDS) assert.ok(petProfile(id).name && petProfile(id).trait)
})
test('a pet picked under an old mood still shows: manual display and preview follow the current mood', () => {
  const f = petService(status())
  const stale = 'pet:yaya:idle:2026-10-29'
  assert.ok(f.service.snapshot().cards.some((c) => c.id === stale))
  // Quota drops under 20% after the page loaded: the idle card id no longer exists.
  f.set(status(quota(95)))
  assert.equal(
    f.service.snapshot().cards.some((c) => c.id === stale),
    false,
  )
  assert.equal(f.service.resolveCard(stale)?.id, 'pet:yaya:hungry:2026-10-29')
  assert.equal(f.service.resolveCard('pet:fangfang:sleepy:2026-10-29')?.pet?.id, 'fangfang')
  assert.equal(f.service.resolveCard('pet:dragon:idle:2026-10-29'), undefined)
  assert.equal(f.service.resolveCard('concept:gone'), undefined)
  assert.equal(f.service.resolveCard(42), undefined)
  f.service.showManual(stale)
  assert.equal(f.service.current()?.id, 'pet:yaya:hungry:2026-10-29')
  assert.equal(f.service.current()?.manual, true)
  assert.throws(() => f.service.showManual('pet:dragon:idle:2026-10-29'), /内容已过期/)
})

const wasmBytes = () =>
  new Uint8Array(readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm'))
// Renderers from 0.0.28 lay `layout: "pet"` cards out with the picture at screen row 32 (older: 60).
const pictureTop = () => {
  const version = JSON.parse(
    readFileSync('apps/desktop/src/renderer/src/device-preview/manifest.json', 'utf8'),
  ).firmwareVersion as string
  const [, minor = 0, patch = 0] = version.split(/[.-]/).map(Number)
  return minor > 0 || patch >= 28 ? 32 : 60
}
test('plane renderer falls back to an all-0xFF red plane when the Wasm has no preview_red_frame', async () => {
  const input = withAmbient(
    toDeviceStatusV1(new StatusHub().snapshot()),
    petCards(status(), noon).find((c) => c.pet!.id === 'yaya')!,
  )
  const real = WebAssembly.instantiate
  // Wrap the real module and hide the red export, as an older renderer build would look.
  ;(WebAssembly as { instantiate: unknown }).instantiate = async (...args: unknown[]) => {
    // Instantiating a compiled Module resolves to the Instance itself.
    const instance = await (real as (...a: unknown[]) => Promise<{ exports: object }>)(...args)
    const exports: Record<string, unknown> = { ...instance.exports }
    delete exports.preview_red_frame
    return { exports }
  }
  try {
    const frame = (await desktopPlanes(wasmBytes()))(input)
    assert.ok(
      frame.black.some((v) => v !== 0xff),
      'the picture is still drawn',
    )
    assert.equal(frame.red.length, 15000)
    assert.ok(
      frame.red.every((v) => v === 0xff),
      'no red anywhere',
    )
    assert.deepEqual(frame.black, (await desktopRenderer(wasmBytes()))(input))
  } finally {
    ;(WebAssembly as { instantiate: unknown }).instantiate = real
  }
})
test('red polarity: a real Wasm render clears the red bit and paints rgb(190,30,45) on the pet cheeks', async () => {
  const exports = WebAssembly.Module.exports(await WebAssembly.compile(wasmBytes()))
  assert.ok(
    exports.some((e) => e.name === 'preview_red_frame'),
    'the checked-in renderer exports the red plane',
  )
  const card = petCards(status(), noon).find((c) => c.pet!.id === 'yaya')!
  const input = withAmbient(toDeviceStatusV1(new StatusHub().snapshot()), card)
  const { black, red } = (await desktopPlanes(wasmBytes()))(input)
  const rgba = planesToRgba(black, red)
  const plane = (bytes: Uint8Array, p: number) => (bytes[p >> 3]! & (0x80 >> (p & 7))) !== 0
  const ink = bits(card.red!.hex)
  const shape = bits(card.imageHex!)
  let redPixels = 0
  for (let row = 0; row < card.red!.h; row++)
    for (let col = 0; col < card.red!.w; col++) {
      // Picture area (0, 0) is screen pixel (8, pictureTop()).
      const p = (pictureTop() + card.red!.y + row) * 400 + 8 + card.red!.x + col
      const wantRed = bitAt(ink, row * card.red!.w + col)
      if (wantRed) {
        redPixels++
        assert.equal(plane(red, p), false, 'red pigment is a cleared bit')
        assert.equal(plane(black, p), true, 'red sits on paper')
        assert.deepEqual([...rgba.slice(p * 4, p * 4 + 4)], [190, 30, 45, 255])
      } else {
        assert.equal(plane(red, p), true, 'no pigment where the card has none')
      }
    }
  assert.ok(redPixels > 50, 'the cheeks are red')
  // Everything outside the red rectangle has no pigment, and black ink stays black.
  let cleared = 0
  for (let p = 0; p < 400 * 300; p++) if (!plane(red, p)) cleared++
  assert.equal(cleared, redPixels)
  let black0 = 0
  for (let n = 0; n < 384 * 208; n++)
    if (bitAt(shape, n)) {
      const p = (pictureTop() + Math.floor(n / 384)) * 400 + 8 + (n % 384)
      assert.equal(plane(black, p), false, 'ink pixel is black')
      assert.deepEqual([...rgba.slice(p * 4, p * 4 + 4)], [0, 0, 0, 255])
      black0++
    }
  assert.ok(black0 > 800)
})
