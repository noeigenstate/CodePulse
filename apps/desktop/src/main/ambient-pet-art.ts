import type { AmbientRedPlane, PetId, PetMood } from '@codepulse/shared'

/**
 * Original pixel art for the three desk pets. Everything is drawn on a 76 x 41 grid of
 * logical pixels that is enlarged 5x into the 384 x 208 multimedia picture area (centred, with
 * a 2 px margin), so edges stay crisp and nothing is dithered. The e-paper only has black, white and red.
 *
 * Sprite legend: '#' black, 'r' red, 'w' paper (clears what is below), '.' leaves the cell.
 * Red is kept for small, meaningful accents (cheeks, a heart, an apple, a status lamp).
 */
export const PET_GRID_WIDTH = 76
export const PET_GRID_HEIGHT = 41
const SCALE = 5
const IMAGE_WIDTH = 384
const IMAGE_HEIGHT = 208
const MARGIN_X = (IMAGE_WIDTH - PET_GRID_WIDTH * SCALE) / 2
const MARGIN_Y = 1
const GROUND = 38
/** MCU limit for one red rectangle, see docs/device-api-v1.md. */
const RED_MAX_BYTES = 3072

type Sprite = readonly string[]

const mirror = (row: string) => row + [...row].reverse().join('')
/** Draw the left half only; the right half is its mirror image. */
const sym = (half: Sprite): Sprite => half.map(mirror)

class Grid {
  /** 0 paper, 1 black, 2 red. */
  readonly cells = new Uint8Array(PET_GRID_WIDTH * PET_GRID_HEIGHT)
  stamp(sprite: Sprite, x: number, y: number): this {
    sprite.forEach((row, dy) =>
      [...row].forEach((ch, dx) => {
        const value = ch === '#' ? 1 : ch === 'r' ? 2 : ch === 'w' ? 0 : -1
        const gx = x + dx,
          gy = y + dy
        if (value < 0) return
        if (gx < 0 || gy < 0 || gx >= PET_GRID_WIDTH || gy >= PET_GRID_HEIGHT)
          throw new Error(`Pet sprite leaves the picture area at ${gx},${gy}`)
        this.cells[gy * PET_GRID_WIDTH + gx] = value
      }),
    )
    return this
  }
  hline(x: number, y: number, length: number): this {
    for (let i = 0; i < length; i++) this.stamp(['#'], x + i, y)
    return this
  }
}

function check(name: string, sprite: Sprite) {
  const width = sprite[0]?.length ?? 0
  sprite.forEach((row, i) => {
    if (row.length !== width)
      throw new Error(`Pet sprite ${name} row ${i} has width ${row.length}, expected ${width}`)
  })
  return sprite
}

// ---------------------------------------------------------------- shared props
const zzz: Sprite = check('zzz', [
  '..........#######.',
  '.............##...',
  '............##....',
  '...#####...##.....',
  '......#...#######.',
  '.....#............',
  '....#####.........',
  '..............###.',
  '................#.',
  '...............##.',
  '..............###.',
])
const moon: Sprite = check('moon', [
  '..rrrr..',
  '.rrr....',
  'rrr.....',
  'rrr.....',
  'rrr.....',
  'rrr.....',
  '.rrr...r',
  '..rrrrr.',
])
const heartBig: Sprite = check('heartBig', [
  '.rr..rr.',
  'rrrrrrrr',
  'rrrrrrrr',
  '.rrrrrr.',
  '..rrrr..',
  '...rr...',
])
const heartSmall: Sprite = check('heartSmall', ['rr.rr', 'rrrrr', '.rrr.', '..r..'])
const sparkle: Sprite = check('sparkle', ['..#..', '..#..', '#####', '..#..', '..#..'])
const sparkleSmall: Sprite = check('sparkleSmall', ['.#.', '###', '.#.'])
const ball: Sprite = check('ball', ['.###.', '#...#', '#.#.#', '#...#', '.###.'])
const bubble: Sprite = check('bubble', [
  '....################....',
  '..##................##..',
  '.#....................#.',
  '#......................#',
  '#......................#',
  '#......................#',
  '#......................#',
  '#......................#',
  '#......................#',
  '.#....................#.',
  '..##................##..',
  '....################....',
])
const bubbleTail: Sprite = check('bubbleTail', ['.##.', '#..#', '#..#', '.##.'])
const bubbleTailSmall: Sprite = check('bubbleTailSmall', ['##', '##'])
const apple: Sprite = check('apple', [
  '.....#..',
  '....##..',
  '.rr.#.rr',
  'rrrrrrrr',
  'rrrrrrrr',
  'rrrrrrrr',
  '.rrrrrr.',
  '..r..r..',
])
const bowl: Sprite = check('bowl', [
  '##############',
  '#............#',
  '.#..........#.',
  '..##########..',
])
const growl: Sprite = check('growl', ['#.', '.#', '#.', '.#'])
const terminal: Sprite = check('terminal', [
  '##############################',
  '#.rr.........................#',
  '#.rr.........................#',
  '##############################',
  '#............................#',
  '#.##.......##.....#####......#',
  '#............................#',
  '#...##.####.........####.....#',
  '#............................#',
  '#.##.....###.....##..........#',
  '#............................#',
  '#.#####..##...####...........#',
  '#............................#',
  '##############################',
])

// ---------------------------------------------------------------------- cat
/** 团团: a round, sleepy loaf of a cat. Left half only. */
const catBody: Sprite = check('catBody', [
  '...##..........',
  '..#..#.........',
  '.#....#........',
  '.#.....########',
  '.#.............',
  '.#.............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '#..............',
  '.#.............',
  '.#.............',
  '..#............',
  '...#...........',
  '....###########',
  '....###........',
])
const catTailUp: Sprite = check('catTailUp', [
  '..##...',
  '.#..#..',
  '.#..#..',
  '.#.#...',
  '.#.#...',
  '..#....',
  '..#....',
  '.#.....',
])
const catTailDown: Sprite = check('catTailDown', [
  '####...',
  '...#...',
  '...#...',
  '..#....',
  '.#.....',
])
const catFace: Record<PetMood, Sprite> = {
  idle: check('catIdle', [
    '..##......',
    '..##......',
    '..........',
    '.rrr......',
    '.rrr...#..',
    '........##',
  ]),
  working: check('catWorking', [
    '..........',
    '.###......',
    '..........',
    '.rrr......',
    '.rrr....##',
    '..........',
  ]),
  hungry: check('catHungry', [
    '..#.......',
    '.##.......',
    '..##......',
    '..##......',
    '.rrr...###',
    '.rrr..####',
    '.......###',
  ]),
  happy: check('catHappy', [
    '..##......',
    '.#..#.....',
    '..........',
    '.rrr......',
    '.rrr..####',
    '......#rrr',
    '.......###',
  ]),
  sleepy: check('catSleepy', [
    '..........',
    '.#..#.....',
    '..##......',
    '.rrr......',
    '.rrr.....#',
    '.........#',
  ]),
}

// ------------------------------------------------------------------- sprout
/** 芽芽: a round little seedling; the leaves tell its mood. Left half only. */
const sproutBody: Sprite = check('sproutBody', [
  '......########',
  '....##........',
  '..##..........',
  '.#............',
  '.#............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '#.............',
  '.#............',
  '.#............',
  '..##..........',
  '....##........',
  '......########',
  '....###.......',
])
const sproutLeavesUp: Sprite = check('sproutLeavesUp', [
  '.##....',
  '####...',
  '#####..',
  '.#####.',
  '...###.',
  '......#',
  '......#',
])
const sproutLeavesDown: Sprite = check('sproutLeavesDown', [
  '......#',
  '..###.#',
  '.#####.',
  '#####..',
  '###....',
  '#......',
])
const sproutFace: Record<PetMood, Sprite> = {
  idle: check('sproutIdle', [
    '...##.....',
    '...##.....',
    '...##.....',
    '..........',
    '.rrr......',
    '.rrr....#.',
    '.........#',
  ]),
  working: check('sproutWorking', [
    '..####....',
    '.#....#...',
    '.#.##.#...',
    '.#.##.#...',
    '..####....',
    '.rrr......',
    '.rrr....##',
  ]),
  hungry: check('sproutHungry', [
    '..##......',
    '..##......',
    '.#.#......',
    '..........',
    '.rrr....##',
    '.rrr...#..',
    '........##',
  ]),
  happy: check('sproutHappy', [
    '..##......',
    '.#..#.....',
    '..........',
    '.rrr......',
    '.rrr..####',
    '......#rrr',
    '.......###',
  ]),
  sleepy: check('sproutSleepy', [
    '..........',
    '.#..#.....',
    '..##......',
    '..........',
    '.rrr......',
    '.rrr.....#',
    '.........#',
  ]),
}

// -------------------------------------------------------------------- robot
/** 方方: a boxy helper robot with a screen face and a status lamp. Left half only. */
const robotBody: Sprite = check('robotBody', [
  '..############',
  '.#............',
  '#.............',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#..###########',
  '#.............',
  '.#............',
  '..############',
  '...####.......',
  '...####.......',
])
const robotBolt: Sprite = check('robotBolt', ['##', '##', '##', '##', '##', '##'])
const robotLampOn: Sprite = check('robotLampOn', [
  '.rr.',
  'rrrr',
  'rrrr',
  '.rr.',
  '.##.',
  '.##.',
  '.##.',
])
const robotLampOff: Sprite = check('robotLampOff', [
  '.##.',
  '#..#',
  '#..#',
  '.##.',
  '.##.',
  '.##.',
  '.##.',
])
const robotSignal: Sprite = check('robotSignal', ['#...#', '.#.#.', '#...#'])
/** Screen faces are 22 x 13 and drawn in paper ('w') and red on the black screen. */
const robotFace: Record<PetMood, Sprite> = {
  idle: sym([
    '...........',
    '...........',
    '...........',
    '...ww......',
    '...ww......',
    '...ww......',
    '...ww......',
    '...........',
    '.rr........',
    '.rr.....www',
    '...........',
    '...........',
    '...........',
  ]),
  working: check('robotWorking', [
    '......................',
    '..ww..................',
    '...ww.................',
    '....ww................',
    '...ww.................',
    '..ww...rrrr...........',
    '......................',
    '.wwwww..ww.wwww.......',
    '......................',
    '.ww.wwwwww............',
    '......................',
    '.wwww..www............',
    '......................',
  ]),
  hungry: check('robotHungry', [
    '......................',
    '..wwwwwwwwwwwwww......',
    '..w............w.ww...',
    '..w.rrr........w.ww...',
    '..w.rrr........www....',
    '..w.rrr........w......',
    '..w............w......',
    '..wwwwwwwwwwwwww......',
    '......................',
    '........wwww..........',
    '.......w....w.........',
    '......................',
    '......................',
  ]),
  happy: check('robotHappy', [
    '......................',
    '......................',
    '....ww........ww......',
    '...w..w......w..w.....',
    '......................',
    '......................',
    '.rr..............rr...',
    '.rr....wwwwww....rr...',
    '.......w....w.........',
    '........wwww..........',
    '......................',
    '......................',
    '......................',
  ]),
  sleepy: check('robotSleepy', [
    '......................',
    '......................',
    '......................',
    '...w..w.....w..w......',
    '....ww.......ww.......',
    '......................',
    '.rr..............rr...',
    '.rr......ww...........',
    '......................',
    '...............ww.....',
    '................w.....',
    '...............ww.....',
    '......................',
  ]),
}
/** The robot's face rows are 22 wide except where a half sprite is mirrored above. */
for (const [mood, rows] of Object.entries(robotFace)) check('robot face ' + mood, rows)

// ------------------------------------------------------------------ composer
interface Placement {
  /** Centre column of the pet on the 76-wide grid. */
  cx: number
  /** Row the pet stands on. */
  bottom: number
}

function drawCat(g: Grid, mood: PetMood, { cx, bottom }: Placement) {
  const body = sym(catBody)
  const x = cx - catBody[0]!.length,
    y = bottom - body.length + 1
  const down = mood === 'hungry' || mood === 'sleepy'
  const tail = down ? catTailDown : catTailUp
  g.stamp(tail, x + body[0]!.length - 2, down ? bottom - 6 : y + 13)
  g.stamp(body, x, y)
  g.stamp(sym(catFace[mood]), x + 5, y + 9)
}

function drawSprout(g: Grid, mood: PetMood, { cx, bottom }: Placement) {
  const body = sym(sproutBody)
  const x = cx - sproutBody[0]!.length,
    y = bottom - body.length + 1
  const leaves = mood === 'hungry' || mood === 'sleepy' ? sproutLeavesDown : sproutLeavesUp
  g.stamp(sym(leaves), cx - leaves[0]!.length, y - leaves.length + 1)
  g.stamp(body, x, y)
  g.stamp(sym(sproutFace[mood]), x + 4, y + 6)
}

function drawRobot(g: Grid, mood: PetMood, { cx, bottom }: Placement) {
  const body = sym(robotBody)
  const x = cx - robotBody[0]!.length,
    y = bottom - body.length + 1
  const awake = mood === 'working' || mood === 'happy' || mood === 'idle'
  g.stamp(awake ? robotLampOn : robotLampOff, cx - 2, y - 7)
  if (mood === 'working') g.stamp(robotSignal, cx - 8, y - 6).stamp(robotSignal, cx + 3, y - 6)
  g.stamp(robotBolt, x - 2, y + 7).stamp(robotBolt, x + body[0]!.length, y + 7)
  g.stamp(body, x, y)
  g.stamp(robotFace[mood], x + 3, y + 3)
}

const DRAW: Record<PetId, (g: Grid, mood: PetMood, at: Placement) => void> = {
  tuantuan: drawCat,
  yaya: drawSprout,
  fangfang: drawRobot,
}

function drawProps(g: Grid, mood: PetMood) {
  if (mood === 'idle') g.stamp(ball, 54, GROUND - 5)
  if (mood === 'working') g.stamp(terminal, 42, GROUND - terminal.length)
  if (mood === 'sleepy') g.stamp(zzz, 50, 2).stamp(moon, 20, 6)
  if (mood === 'happy') {
    g.stamp(heartBig, 46, 8).stamp(heartSmall, 56, 4)
    g.stamp(sparkle, 8, 12).stamp(sparkleSmall, 20, 4).stamp(sparkle, 62, 20)
    g.stamp(sparkleSmall, 66, 30)
  }
  if (mood === 'hungry') {
    g.stamp(bubble, 48, 4).stamp(apple, 56, 6)
    g.stamp(bubbleTail, 47, 12).stamp(bubbleTailSmall, 44, 16)
    g.stamp(bowl, 2, GROUND - bowl.length).stamp(growl, 16, 26)
  }
}

/** Where the pet stands; it shifts aside for whatever shares the picture. */
function layout(mood: PetMood): Placement {
  if (mood === 'working') return { cx: 22, bottom: GROUND - 1 }
  if (mood === 'hungry') return { cx: 34, bottom: GROUND - 1 }
  if (mood === 'happy') return { cx: 34, bottom: GROUND - 6 }
  return { cx: 34, bottom: GROUND - 1 }
}

function ground(g: Grid, mood: PetMood) {
  if (mood === 'happy') g.hline(24, GROUND, 20)
  else g.hline(6, GROUND, 64)
}

export interface PetArt {
  /** 384 x 208, row-major, MSB first, 1 = black. */
  imageHex: string
  /** Smallest byte-aligned rectangle around the red ink, if the scene has any. */
  red?: AmbientRedPlane
}

const cache = new Map<string, PetArt>()

/** Render one pet in one mood. Results are cached because the art never changes at run time. */
export function renderPetArt(id: PetId, mood: PetMood): PetArt {
  const key = id + ':' + mood
  const cached = cache.get(key)
  if (cached) return cached
  const grid = new Grid()
  ground(grid, mood)
  drawProps(grid, mood)
  DRAW[id](grid, mood, layout(mood))
  const art = pack(grid)
  cache.set(key, art)
  return art
}

function pack(grid: Grid): PetArt {
  const black = Buffer.alloc((IMAGE_WIDTH * IMAGE_HEIGHT) / 8)
  const at = (px: number, py: number) => {
    const gx = Math.floor((px - MARGIN_X) / SCALE),
      gy = Math.floor((py - MARGIN_Y) / SCALE)
    return gx < 0 || gy < 0 || gx >= PET_GRID_WIDTH || gy >= PET_GRID_HEIGHT
      ? 0
      : grid.cells[gy * PET_GRID_WIDTH + gx]!
  }
  let minX = IMAGE_WIDTH,
    maxX = -1,
    minY = IMAGE_HEIGHT,
    maxY = -1
  for (let py = 0; py < IMAGE_HEIGHT; py++)
    for (let px = 0; px < IMAGE_WIDTH; px++) {
      const cell = at(px, py)
      if (cell === 1) {
        const bit = py * IMAGE_WIDTH + px
        black[bit >> 3] = black[bit >> 3]! | (128 >> (bit & 7))
      } else if (cell === 2) {
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
      }
    }
  const imageHex = black.toString('hex')
  if (maxX < 0) return { imageHex }
  const x = Math.floor(minX / 8) * 8,
    w = Math.ceil((maxX + 1) / 8) * 8 - x,
    y = minY,
    h = maxY - minY + 1
  if ((w * h) / 8 > RED_MAX_BYTES) throw new Error('Pet red area exceeds the device limit')
  const red = Buffer.alloc((w * h) / 8)
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++)
      if (at(x + col, y + row) === 2) {
        const bit = row * w + col
        red[bit >> 3] = red[bit >> 3]! | (128 >> (bit & 7))
      }
  return { imageHex, red: { x, y, w, h, hex: red.toString('hex') } }
}
