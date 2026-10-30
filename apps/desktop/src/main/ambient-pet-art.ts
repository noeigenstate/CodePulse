import type { AmbientRedPlane, PetId, PetMood } from '@codepulse/shared'

/**
 * Original line art for the three desk pets, drawn 1:1 on the 384 x 208 multimedia picture area
 * (about 119 PPI), so outlines are smooth curves instead of enlarged pixels. The e-paper only has
 * black, white and red, so there is no anti-aliasing: every pixel is decided by sampling a signed
 * distance function at its centre, which is deterministic and keeps 2 to 3 px strokes unbroken.
 *
 * Conventions: outlines are 3 px, details 2 to 3 px, black blocks (eyes, inner ears, screens) give
 * depth. Red is only used for small accents (cheeks, hearts, an apple, a moon, a status lamp).
 */
const WIDTH = 384
const HEIGHT = 208
/** MCU limit for one red rectangle, see docs/device-api-v1.md. */
const RED_MAX_BYTES = 3072
/** The ground line occupies rows 197..199; pets stand with their feet on row 196. */
const GROUND = 197
/** Centre column shared by the three pets. */
const PET_X = 106

const PAPER = 0
const INK = 1
const RED = 2
type Color = 0 | 1 | 2
type Pt = readonly [number, number]
/** Points from a flat list of coordinates: pl(x0, y0, x1, y1, ...). */
const pl = (...n: number[]): Pt[] =>
  Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!])

// ------------------------------------------------------------------ shapes
/** A shape is a signed distance function (negative inside) plus a box that bounds its ink. */
interface Shape {
  box: readonly [number, number, number, number]
  sd(x: number, y: number): number
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Shape {
  return {
    box: [cx - rx, cy - ry, cx + rx, cy + ry],
    sd(x, y) {
      const dx = x - cx,
        dy = y - cy
      const k0 = Math.hypot(dx / rx, dy / ry)
      const k1 = Math.hypot(dx / (rx * rx), dy / (ry * ry))
      return k1 < 1e-9 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1
    },
  }
}
const circle = (cx: number, cy: number, r: number) => ellipse(cx, cy, r, r)

/** Rounded box with its own corner radius for the upper and the lower half. */
function rrect(cx: number, cy: number, hw: number, hh: number, rTop: number, rBot = rTop): Shape {
  return {
    box: [cx - hw, cy - hh, cx + hw, cy + hh],
    sd(x, y) {
      const py = y - cy
      const r = py < 0 ? rTop : rBot
      const qx = Math.abs(x - cx) - hw + r,
        qy = Math.abs(py) - hh + r
      return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
    },
  }
}

function segDist(px: number, py: number, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax,
    dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function boxOf(pts: readonly Pt[], pad: number): Shape['box'] {
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1])
  return [
    Math.min(...xs) - pad,
    Math.min(...ys) - pad,
    Math.max(...xs) + pad,
    Math.max(...ys) + pad,
  ]
}

/** Closed polygon, even-odd. */
function poly(pts: readonly Pt[]): Shape {
  return {
    box: boxOf(pts, 0),
    sd(x, y) {
      let d = Infinity,
        inside = false
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j]!,
          b = pts[i]!
        d = Math.min(d, segDist(x, y, a, b))
        if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
          inside = !inside
      }
      return inside ? -d : d
    },
  }
}

/** A thick open polyline with round caps. */
function path(pts: readonly Pt[], width: number): Shape {
  return {
    box: boxOf(pts, width / 2),
    sd(x, y) {
      let d = Infinity
      for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(x, y, pts[i - 1]!, pts[i]!))
      return d - width / 2
    },
  }
}

/** Offset a shape outwards (d > 0) or inwards (d < 0); positive values also round its corners. */
const grow = (s: Shape, d: number): Shape => ({
  box: [s.box[0] - d, s.box[1] - d, s.box[2] + d, s.box[3] + d],
  sd: (x, y) => s.sd(x, y) - d,
})
const union = (...s: Shape[]): Shape => ({
  box: [
    Math.min(...s.map((a) => a.box[0])),
    Math.min(...s.map((a) => a.box[1])),
    Math.max(...s.map((a) => a.box[2])),
    Math.max(...s.map((a) => a.box[3])),
  ],
  sd: (x, y) => Math.min(...s.map((a) => a.sd(x, y))),
})
const subtract = (a: Shape, b: Shape): Shape => ({
  box: a.box,
  sd: (x, y) => Math.max(a.sd(x, y), -b.sd(x, y)),
})
const intersect = (a: Shape, b: Shape): Shape => ({
  box: a.box,
  sd: (x, y) => Math.max(a.sd(x, y), b.sd(x, y)),
})
/** Everything at or below the row y0, as a half-plane for cutting shapes. */
const below = (y0: number): Shape => ({ box: [-1e4, y0, 1e4, 1e4], sd: (_x, y) => y0 - y })

// ------------------------------------------------------------------ curves
const quad = (a: Pt, b: Pt, c: Pt, n = 20): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n,
      u = 1 - t
    return [
      u * u * a[0] + 2 * u * t * b[0] + t * t * c[0],
      u * u * a[1] + 2 * u * t * b[1] + t * t * c[1],
    ]
  })

/** Elliptic arc; angles in degrees, 0 = right, 90 = down. */
const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt
  })

/** Catmull-Rom spline through the points, `per` samples per segment. */
function spline(pts: readonly Pt[], per = 10): Pt[] {
  const cr = (a: number, b: number, c: number, d: number, t: number) =>
    0.5 *
    (2 * b +
      (c - a) * t +
      (2 * a - 5 * b + 4 * c - d) * t * t +
      (3 * b - a - 3 * c + d) * t * t * t)
  const out: Pt[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!,
      p1 = pts[i]!,
      p2 = pts[i + 1]!,
      p3 = pts[Math.min(pts.length - 1, i + 2)]!
    for (let k = 0; k < per; k++)
      out.push([cr(p0[0], p1[0], p2[0], p3[0], k / per), cr(p0[1], p1[1], p2[1], p3[1], k / per)])
  }
  out.push(pts[pts.length - 1]!)
  return out
}

/** A heart `size` px wide, centred on (cx, cy). */
function heart(cx: number, cy: number, size: number): Shape {
  const raw: Pt[] = Array.from({ length: 64 }, (_, i) => {
    const t = (i / 64) * Math.PI * 2
    return [
      16 * Math.sin(t) ** 3,
      -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
    ]
  })
  const [x0, y0, x1, y1] = boxOf(raw, 0)
  const k = size / (x1 - x0)
  return poly(raw.map(([x, y]) => [cx + x * k, cy + (y - (y0 + y1) / 2) * k] as Pt))
}

/** Four-pointed sparkle with round tips. */
function sparkle(cx: number, cy: number, r: number): Shape {
  const pts: Pt[] = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4,
      d = i % 2 === 0 ? r - 1.5 : r * 0.26
    return [cx + d * Math.cos(a), cy + d * Math.sin(a)]
  })
  return grow(poly(pts), 1.5)
}

/** A leaf grown along an axis that bends from angle a0 to a1 (degrees clockwise from straight up). */
function leaf(base: Pt, a0: number, a1: number, len: number, half: number) {
  const n = 24,
    axis: Pt[] = [base]
  for (let i = 0; i < n; i++) {
    const a = ((a0 + ((a1 - a0) * (i + 0.5)) / n) * Math.PI) / 180
    const [x, y] = axis[i]!
    axis.push([x + (len / n) * Math.sin(a), y - (len / n) * Math.cos(a)])
  }
  const left: Pt[] = [],
    right: Pt[] = []
  axis.forEach(([x, y], i) => {
    const [px, py] = axis[Math.max(0, i - 1)]!,
      [nx, ny] = axis[Math.min(n, i + 1)]!
    const l = Math.hypot(nx - px, ny - py)
    const w = (half - 2) * Math.sin(Math.PI * (i / n) ** 0.8)
    left.push([x + (-(ny - py) / l) * w, y + ((nx - px) / l) * w])
    right.push([x + ((ny - py) / l) * w, y + (-(nx - px) / l) * w])
  })
  return { shape: grow(poly([...left, ...right.reverse()]), 2), axis }
}

// ------------------------------------------------------------------ canvas
class Canvas {
  /** 0 paper, 1 black, 2 red. */
  readonly px = new Uint8Array(WIDTH * HEIGHT)

  fill(s: Shape, color: Color): this {
    const [x0, y0, x1, y1] = s.box
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(HEIGHT - 1, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(WIDTH - 1, Math.ceil(x1)); x++)
        if (s.sd(x + 0.5, y + 0.5) <= 0) this.px[y * WIDTH + x] = color
    return this
  }
  /** A line of the given width centred on the points. */
  line(pts: readonly Pt[], width: number, color: Color = INK): this {
    return this.fill(path(pts, width), color)
  }
  /** Black outline of `width` px just inside the shape, with `inner` filling the rest. */
  outlined(s: Shape, width = 3, inner: Color = PAPER): this {
    return this.fill(s, INK).fill(grow(s, -width), inner)
  }
  /** Several parts share one outline: no line is drawn where they overlap. */
  silhouette(parts: readonly Shape[], width = 3): this {
    for (const p of parts) this.fill(p, INK)
    for (const p of parts) this.fill(grow(p, -width), PAPER)
    return this
  }
}

// -------------------------------------------------------------------- face
interface FaceOpts {
  cx: number
  /** Eye row. */
  y: number
  /** Half the distance between the eyes. */
  dx: number
  /** Stroke colour, and the colour of cut-outs (highlights) inside black. */
  fg: Color
  bg: Color
  /** Scales the sizes of eyes, brows and mouth. */
  s?: number
  square?: boolean
  mouth: 'cat' | 'smile'
  /** Draw the focus brows in the working mood (off when glasses are in the way). */
  brows?: boolean
}

/** Eyes, brows and mouth. The same layout serves all pets; `fg`/`bg` swap for the robot's black screen. */
function face(c: Canvas, mood: PetMood, o: FaceOpts) {
  const { cx, y, dx, fg, bg } = o
  const s = o.s ?? 1
  const eye = (sx: number, ex: number, ey: number, rx: number, ry: number) => {
    const x = cx + sx * dx
    c.fill(
      o.square
        ? rrect(x + ex, y + ey, rx * s, ry * s, 5 * s)
        : ellipse(x + ex, y + ey, rx * s, ry * s),
      fg,
    )
  }
  const glint = (sx: number, gx: number, gy: number, r: number) => {
    // The robot's square eyes stay plain.
    if (!o.square) c.fill(circle(cx + sx * dx + gx * s, y + gy * s, r * s), bg)
  }
  const stroke = (pts: Pt[], w = 3) => c.line(pts, w, fg)
  const mx = cx,
    my = y + 20 * s
  for (const sx of [-1, 1]) {
    if (mood === 'happy') {
      stroke(arc(cx + sx * dx, y + 6 * s, 11 * s, 11 * s, 205, 335))
    } else if (mood === 'sleepy') {
      stroke(arc(cx + sx * dx, y - 6 * s, 11 * s, 9 * s, 25, 155))
    } else if (mood === 'working') {
      eye(sx, 3 * s, 0, 7, 7.5)
      glint(sx, 5, -2.5, 2.4)
      if (o.brows !== false)
        stroke(
          pl(cx + sx * dx - 8 * s, y - 15 * s + sx * 2, cx + sx * dx + 8 * s, y - 15 * s - sx * 2),
        )
    } else {
      const hungry = mood === 'hungry'
      eye(sx, 0, 0, hungry ? 7.5 : 6.5, hungry ? 10 : 8.5)
      glint(sx, -2, -3, hungry ? 3 : 2.5)
      if (hungry) {
        glint(sx, 2.5, 3, 1.6)
        // Worried brows: the inner ends are raised.
        stroke(pl(cx + sx * (dx + 12 * s), y - 17 * s, cx + sx * (dx - 8 * s), y - 25 * s))
      }
    }
  }
  if (mood === 'happy') {
    // Open laughing mouth with a red tongue.
    c.fill(intersect(ellipse(mx, my - 2 * s, 13 * s, 15 * s), below(my - 2 * s)), fg)
    c.fill(intersect(ellipse(mx, my + 10 * s, 7 * s, 5 * s), below(my + 5 * s)), RED)
  } else if (mood === 'sleepy') {
    stroke(quad([mx - 6 * s, my + 1 * s], [mx, my + 8 * s], [mx + 6 * s, my + 1 * s], 10))
  } else if (mood === 'working') {
    stroke(pl(mx - 7 * s, my + 2 * s, mx + 7 * s, my + 2 * s))
  } else if (mood === 'hungry') {
    stroke(quad([mx - 10 * s, my + 8 * s], [mx, my - 3 * s], [mx + 10 * s, my + 8 * s]))
  } else if (o.mouth === 'cat') {
    stroke(quad([mx, my - 6], [mx - 2, my + 6], [mx - 13, my + 2], 12), 2.5)
    stroke(quad([mx, my - 6], [mx + 2, my + 6], [mx + 13, my + 2], 12), 2.5)
  } else {
    stroke(quad([mx - 10 * s, my], [mx, my + 11 * s], [mx + 10 * s, my], 14))
  }
}

const cheeks = (c: Canvas, cx: number, y: number, dx: number, rx = 11, ry = 7) =>
  c.fill(ellipse(cx - dx, y, rx, ry), RED).fill(ellipse(cx + dx, y, rx, ry), RED)

// --------------------------------------------------------------------- pets
/** 团团: a round loaf of a cat. `base` is the row its feet stand on. */
function drawCat(c: Canvas, mood: PetMood, base: number) {
  const cx = PET_X
  const droopy = mood === 'hungry' || mood === 'sleepy'
  const P = (dx: number, dy: number): Pt => [cx + dx, base + dy]
  // Curled tail behind the body: raised when awake, resting on the floor when tired.
  const tail = spline(
    mood === 'happy'
      ? [P(60, -24), P(88, -36), P(102, -64), P(98, -92), P(84, -104), P(72, -96)]
      : mood === 'working'
        ? [P(60, -22), P(84, -28), P(98, -52), P(94, -78), P(82, -84)]
        : droopy
          ? [P(60, -12), P(84, -9), P(100, -11), P(109, -22), P(101, -33), P(91, -28)]
          : [P(60, -22), P(92, -26), P(112, -52), P(110, -84), P(96, -98), P(84, -90)],
  )
  c.line(tail, 17).line(tail, 11, PAPER).line(tail.slice(-20), 17)
  const body = rrect(cx, base - 66, 74, 66, 56, 30)
  // Ears: triangles with rounded tips; they lean outwards when the cat is sad or asleep.
  const lean = droopy ? 3 : 0
  const ear = (sx: number): Pt[] => [
    P(sx * 66, -96),
    P(sx * (54 + lean), -141 + lean * 2),
    P(sx * 16, -124),
  ]
  c.silhouette([body, grow(poly(ear(-1)), 5), grow(poly(ear(1)), 5)])
  for (const sx of [-1, 1]) {
    const [a, b, t] = ear(sx) as [Pt, Pt, Pt]
    const q: Pt = [(a[0] + b[0] + t[0]) / 3, (a[1] + b[1] + t[1]) / 3]
    const inner = grow(
      poly(
        [a, b, t].map((p) => [q[0] + (p[0] - q[0]) * 0.6, q[1] + (p[1] - q[1]) * 0.6 - 6] as Pt),
      ),
      1,
    )
    c.fill(subtract(inner, grow(body, 5)), INK)
  }
  // Whiskers (outside the cheeks), face and paws.
  for (const sx of [-1, 1])
    for (const dy of [-8, 6]) c.line([P(sx * 72, -62 + dy / 2), P(sx * 94, -62 + dy * 1.6)], 2)
  const ey = base - 80
  face(c, mood, { cx, y: ey, dx: 34, fg: INK, bg: PAPER, mouth: 'cat' })
  c.fill(ellipse(cx, ey + 15, 5, 3.5), INK)
  cheeks(c, cx, ey + 20, 54)
  for (const sx of [-1, 1]) {
    c.outlined(ellipse(cx + sx * 27, base - 11, 21, 11))
    for (const dx of [-5, 6]) c.line([P(sx * 27 + dx, -10), P(sx * 27 + dx, -3)], 2)
  }
}

/** 芽芽: a round dumpling whose two leaves show its mood. */
function drawSprout(c: Canvas, mood: PetMood, base: number) {
  const cx = PET_X
  const top: Pt = [cx, base - 124]
  // Leaf pose per mood: [start angle, end angle] on the right-hand leaf, mirrored on the left.
  const pose: Record<PetMood, [number, number, number]> = {
    idle: [36, 60, 54],
    working: [16, 28, 54],
    hungry: [95, 168, 44],
    happy: [64, 90, 56],
    sleepy: [5, 10, 54],
  }
  const [a0, a1, len] = pose[mood]
  const leaves = () =>
    [-1, 1].forEach((sx) => {
      const { shape, axis } = leaf(top, sx * a0, sx * a1, len, 17)
      c.outlined(shape).line(axis.slice(3, 21), 2)
    })
  c.line([[cx, base - 104], top], 6)
  // Drooping leaves hang in front of the body, the others stand behind it.
  if (mood !== 'hungry') leaves()
  c.outlined(rrect(cx, base - 56, 80, 56, 54, 40))
  if (mood === 'hungry') leaves()
  const ey = base - 68
  if (mood === 'working') {
    // Round glasses; the eyes are drawn inside them.
    for (const sx of [-1, 1]) c.outlined(circle(cx + sx * 36, ey, 19), 3)
    c.line(pl(cx - 17, ey - 3, cx + 17, ey - 3), 3)
  }
  face(c, mood, {
    cx,
    y: ey,
    dx: 36,
    fg: INK,
    bg: PAPER,
    mouth: 'smile',
    brows: mood !== 'working',
  })
  cheeks(c, cx, ey + 18, 58)
}

/** 方方: a small robot whose face is a black screen; expressions are drawn in white on it. */
function drawRobot(c: Canvas, mood: PetMood, base: number) {
  const cx = PET_X
  const awake = mood !== 'sleepy'
  const hy = base - 98
  const P = (dx: number, dy: number): Pt => [cx + dx, base + dy]
  for (const sx of [-1, 1]) {
    // Arms: they go up when the robot is happy.
    const arm =
      mood === 'happy'
        ? [P(sx * 40, -44), P(sx * 62, -62), P(sx * 66, -82)]
        : [P(sx * 40, -40), P(sx * 62, -34), P(sx * 66, -20)]
    c.line(arm, 15).line(arm, 9, PAPER)
    c.outlined(rrect(cx + sx * 26, base - 8, 18, 8, 6))
  }
  c.outlined(rrect(cx, base - 36, 46, 20, 10, 14))
  // Antenna with a lamp: lit (red) while awake.
  c.line([P(0, -134), P(0, -150)], 6)
  c.outlined(circle(cx, base - 164, 9), 3, awake ? RED : PAPER)
  if (mood === 'working')
    for (const sx of [-1, 1])
      c.line(arc(cx + sx * 4, base - 164, 20, 20, sx > 0 ? -50 : 130, sx > 0 ? 50 : 230, 12), 2.5)
  c.outlined(rrect(cx, hy, 70, 42, 22))
  for (const sx of [-1, 1]) {
    // Bolts on both sides of the head.
    c.outlined(rrect(cx + sx * 76, hy, 8, 17, 5))
    c.fill(circle(cx + sx * 77, hy, 3.5), INK)
  }
  c.fill(rrect(cx, hy, 57, 31, 14), INK)
  face(c, mood, {
    cx,
    y: hy - 6,
    dx: 26,
    fg: PAPER,
    bg: INK,
    s: 0.85,
    square: true,
    mouth: 'smile',
  })
  cheeks(c, cx, hy + 9, 44, 8, 5)
}

const PETS: Record<PetId, (c: Canvas, mood: PetMood, base: number) => void> = {
  tuantuan: drawCat,
  yaya: drawSprout,
  fangfang: drawRobot,
}

// ------------------------------------------------------------------- props
const zee = (c: Canvas, x: number, y: number, s: number) =>
  c.line(pl(x, y, x + s, y, x, y + s, x + s, y + s), 3.5)

/** Stomach rumble marks to the left of a hungry pet. */
function growl(c: Canvas, x: number, y: number) {
  for (const r of [14, 24]) c.line(arc(x + 34, y, r, r, 145, 215, 10), 3)
}

function drawProps(c: Canvas, mood: PetMood) {
  if (mood === 'idle') {
    // A toy ball with motion dashes.
    c.outlined(circle(286, 172, 25))
    c.line(pl(263, 172, 309, 172), 2).line(arc(286, 172, 10, 22, 0, 360, 32), 2)
    for (const [x, y, w] of [
      [236, 156, 16],
      [228, 166, 20],
      [236, 176, 14],
    ] as const)
      c.line(pl(x, y, x + w, y), 3)
  } else if (mood === 'working') {
    // A small monitor showing a terminal: title bar with lamps, then lines of code.
    c.outlined(rrect(304, 124, 62, 44, 8)).fill(rrect(304, 98, 59, 15, 5, 0), INK)
    c.fill(circle(254, 98, 4.5), RED)
      .fill(circle(266, 98, 3.5), PAPER)
      .fill(circle(277, 98, 3.5), PAPER)
    c.line(pl(254, 112, 262, 118, 254, 124), 3).line(pl(270, 118, 304, 118), 3)
    for (const [x0, y, x1] of [
      [262, 132, 326],
      [262, 146, 296],
      [306, 146, 338],
    ] as const)
      c.line(pl(x0, y, x1, y), 3)
    c.fill(rrect(352, 146, 4, 7, 1), INK)
    c.outlined(rect(298, 168, 12, 16)).outlined(rrect(304, 190, 36, 7, 6, 3))
  } else if (mood === 'sleepy') {
    // A red crescent moon and drifting z's.
    c.fill(subtract(circle(252, 82, 24), circle(263, 72, 21)), RED)
    zee(c, 278, 114, 15)
    zee(c, 300, 90, 20)
    zee(c, 328, 58, 26)
  } else if (mood === 'happy') {
    c.fill(heart(226, 66, 34), RED).fill(heart(260, 90, 18), RED)
    for (const [x, y, r] of [
      [300, 52, 14],
      [316, 116, 18],
      [18, 48, 12],
      [356, 72, 10],
      [268, 150, 11],
    ] as const)
      c.fill(sparkle(x, y, r), INK)
    c.line(pl(PET_X - 46, 192, PET_X + 46, 192), 5) // shadow under the jump
  } else {
    // Stomach rumbles, a thought bubble with a red apple, and an empty bowl.
    growl(c, 0, 165)
    const bubble = union(
      circle(250, 92, 21),
      circle(276, 72, 25),
      circle(304, 90, 21),
      circle(277, 102, 21),
    )
    c.silhouette([bubble])
      .outlined(circle(228, 128, 8))
      .outlined(circle(214, 142, 5))
    const ax = 277,
      ay = 90
    const lobes = union(
      circle(ax - 8, ay + 1, 15),
      circle(ax + 8, ay + 1, 15),
      ellipse(ax, ay + 7, 21, 14),
    )
    c.fill(subtract(lobes, circle(ax, ay - 14, 5)), RED).line(pl(ax, ay - 8, ax + 3, ay - 22), 3)
    c.fill(grow(poly(pl(ax + 5, ay - 17, ax + 21, ay - 26, ax + 17, ay - 12)), 1.5), INK)
    c.line(arc(ax - 9, ay + 3, 8, 8, 200, 260, 6), 2.5, PAPER)
    c.outlined(intersect(ellipse(318, 168, 46, 29), below(168)))
    c.outlined(ellipse(318, 168, 52, 9)).fill(ellipse(318, 169, 40, 3.5), INK)
  }
}

const rect = (cx: number, cy: number, hw: number, hh: number) => rrect(cx, cy, hw, hh, 0)

// ---------------------------------------------------------------- composer
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
  const canvas = new Canvas()
  canvas.line(pl(12, GROUND + 1.5, 372, GROUND + 1.5), 3)
  drawProps(canvas, mood)
  // A happy pet is in mid-jump, feet off the ground.
  PETS[id](canvas, mood, mood === 'happy' ? GROUND - 16 : GROUND)
  const art = pack(canvas)
  cache.set(key, art)
  return art
}

function pack({ px }: Canvas): PetArt {
  const black = Buffer.alloc((WIDTH * HEIGHT) / 8)
  let minX = WIDTH,
    maxX = -1,
    minY = HEIGHT,
    maxY = -1
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const v = px[y * WIDTH + x]
      if (v === INK) {
        const bit = y * WIDTH + x
        black[bit >> 3] = black[bit >> 3]! | (128 >> (bit & 7))
      } else if (v === RED) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
  const imageHex = black.toString('hex')
  if (maxX < 0) return { imageHex }
  const x = Math.floor(minX / 8) * 8,
    w = Math.ceil((maxX + 1) / 8) * 8 - x,
    y = minY,
    h = maxY - minY + 1
  if ((w * h) / 8 > RED_MAX_BYTES)
    throw new Error(`Pet red area ${w}x${h} at ${x},${y} exceeds the device limit`)
  const red = Buffer.alloc((w * h) / 8)
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++)
      if (px[(y + row) * WIDTH + x + col] === RED) {
        const bit = row * w + col
        red[bit >> 3] = red[bit >> 3]! | (128 >> (bit & 7))
      }
  return { imageHex, red: { x, y, w, h, hex: red.toString('hex') } }
}
