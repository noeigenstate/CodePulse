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
const PET_X = 110

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
/** Rotate p by `deg` (clockwise on screen) around (px, py). */
const rot = (px: number, py: number, deg: number, [x, y]: Pt): Pt => {
  const r = (deg * Math.PI) / 180,
    cos = Math.cos(r),
    sin = Math.sin(r)
  return [px + (x - px) * cos - (y - py) * sin, py + (x - px) * sin + (y - py) * cos]
}

interface Xf {
  fwd(p: Pt): Pt
  inv(x: number, y: number): Pt
}

class Canvas {
  /** 0 paper, 1 black, 2 red. */
  readonly px = new Uint8Array(WIDTH * HEIGHT)
  private xf: Xf | null = null

  /** Draw with everything rotated by `deg` around (px, py), then moved by (tx, ty). Not nestable. */
  xform(px: number, py: number, deg: number, tx: number, ty: number, draw: () => void): this {
    const r = (deg * Math.PI) / 180,
      cos = Math.cos(r),
      sin = Math.sin(r)
    this.xf = {
      fwd: ([x, y]) => [
        px + (x - px) * cos - (y - py) * sin + tx,
        py + (x - px) * sin + (y - py) * cos + ty,
      ],
      inv: (x, y) => {
        const dx = x - tx - px,
          dy = y - ty - py
        return [px + dx * cos + dy * sin, py - dx * sin + dy * cos]
      },
    }
    draw()
    this.xf = null
    return this
  }
  fill(s: Shape, color: Color): this {
    const xf = this.xf
    const [bx0, by0, bx1, by1] = s.box
    const corners = xf
      ? [xf.fwd([bx0, by0]), xf.fwd([bx1, by0]), xf.fwd([bx0, by1]), xf.fwd([bx1, by1])]
      : [
          [bx0, by0],
          [bx1, by1],
        ]
    const xs = corners.map((p) => p[0]!),
      ys = corners.map((p) => p[1]!)
    const y0 = Math.max(0, Math.floor(Math.min(...ys))),
      y1 = Math.min(HEIGHT - 1, Math.ceil(Math.max(...ys)))
    const x0 = Math.max(0, Math.floor(Math.min(...xs))),
      x1 = Math.min(WIDTH - 1, Math.ceil(Math.max(...xs)))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const [lx, ly] = xf ? xf.inv(x + 0.5, y + 0.5) : [x + 0.5, y + 0.5]
        if (s.sd(lx!, ly!) <= 0) this.px[y * WIDTH + x] = color
      }
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
  /** A stubby outlined limb along the points; the end is a round paw. */
  limb(pts: readonly Pt[], w = 14): this {
    const sp = spline(pts, 6)
    return this.line(sp, w).line(sp, w - 6, PAPER)
  }
}

// -------------------------------------------------------------------- face
interface FaceOpts {
  cx: number
  /** Eye row. */
  y: number
  /** Half the distance between the eyes. */
  dx: number
  /** Colour of eyes and strokes, and of the cut-outs inside them (black on paper, or the reverse). */
  ink: Color
  paper: Color
  /** Robot eyes are white with a black pupil; the others are black with white highlights. */
  robot?: boolean
  mouth: 'cat' | 'smile'
  /** Draw the focus brows in the working mood (off when glasses are in the way). */
  brows?: boolean
  /** Looking direction in px (positive = right). */
  gaze?: number
}

const drop = (x: number, y: number, r: number): Shape =>
  union(
    circle(x, y, r),
    grow(poly(pl(x - r * 0.6, y - r * 0.4, x + r * 0.6, y - r * 0.4, x, y - r * 2.3)), 0.6),
  )

/** Big eyes with highlights, brows and a small mouth. Colours swap for the robot's black screen. */
function face(c: Canvas, mood: PetMood, o: FaceOpts) {
  const { cx, y, dx, ink, paper } = o
  const g = o.gaze ?? 0
  const stroke = (pts: Pt[], w = 3) => c.line(pts, w, ink)
  const ball = (sx: number, rx: number, ry: number, glints: number) => {
    const x = cx + sx * dx + g
    c.fill(ellipse(x, y, rx, ry), ink)
    if (o.robot) {
      c.fill(circle(x + g * 0.6, y + 1, 7.5), paper).fill(
        circle(x + g * 0.6 - 2.5, y - 2, 2.6),
        ink,
      )
    } else {
      c.fill(circle(x - 3.5 + g * 0.4, y - 5, 3.8), paper)
      if (glints > 1) c.fill(circle(x + 4.5, y + 5, 2.3), paper)
    }
  }
  for (const sx of [-1, 1]) {
    if (mood === 'happy') stroke(arc(cx + sx * dx, y + 4, 12, 11, 200, 340), 4)
    else if (mood === 'sleepy') stroke(arc(cx + sx * dx, y - 6, 12, 9, 25, 155), 3.5)
    else if (mood === 'working') {
      ball(sx, 10, 11, 1)
      if (o.brows !== false)
        stroke(pl(cx + sx * dx - 10, y - 17 + sx * 2, cx + sx * dx + 10, y - 17 - sx * 2))
    } else if (mood === 'hungry') {
      ball(sx, 11, 14, 2)
      stroke(pl(cx + sx * (dx + 13), y - 20, cx + sx * (dx - 9), y - 29))
    } else ball(sx, 11, 13, 2)
  }
  if (mood === 'hungry') {
    // A tear hangs from the corner of the left eye.
    const t = drop(cx - dx - 2, y + 27, 5)
    if (o.robot) c.fill(t, ink)
    else c.outlined(t, 2.5)
  }
  const mx = cx,
    my = y + 23
  if (mood === 'happy') {
    c.fill(intersect(ellipse(mx, my - 4, 14, 15), below(my - 4)), ink)
    c.fill(intersect(ellipse(mx, my + 8, 7, 5), below(my + 4)), RED)
  } else if (mood === 'sleepy') stroke(quad([mx - 6, my], [mx, my + 7], [mx + 6, my], 10))
  else if (mood === 'working') stroke(pl(mx - 7, my + 2, mx + 7, my + 2))
  else if (mood === 'hungry') stroke(quad([mx - 9, my + 7], [mx, my - 2], [mx + 9, my + 7]))
  else if (o.mouth === 'cat') {
    stroke(quad([mx, my - 7], [mx - 2, my + 5], [mx - 13, my + 1], 12), 2.5)
    stroke(quad([mx, my - 7], [mx + 2, my + 5], [mx + 13, my + 1], 12), 2.5)
  } else stroke(quad([mx - 8, my - 1], [mx, my + 9], [mx + 8, my - 1], 12))
}

const cheeks = (c: Canvas, cx: number, y: number, dx: number, rx = 11, ry = 7) =>
  c.fill(ellipse(cx - dx, y, rx, ry), RED).fill(ellipse(cx + dx, y, rx, ry), RED)

/** Little bubble hanging from the nose of a sleeping pet. */
const snot = (c: Canvas, x: number, y: number) =>
  c.outlined(circle(x, y, 9)).fill(circle(x - 3, y - 3, 2), INK)

// --------------------------------------------------------------------- pets
/** Where the hands go (picture coordinates, before the pet's prop offset): ball, key, bowl. */
const HAND = { ball: [203, 170], key: [221, 183], bowl: [205, 165] } as const

/** Arms for the moods that use them; `shoulder` gives the world position for a side and a height. */
function arms(
  c: Canvas,
  mood: PetMood,
  shoulder: (sx: -1 | 1, high: boolean) => Pt,
  ox: number,
  w: number,
) {
  const [sL, sR, hL, hR] = [
    shoulder(-1, false),
    shoulder(1, false),
    shoulder(-1, true),
    shoulder(1, true),
  ]
  const to = (a: Pt, h: readonly [number, number]): Pt[] => {
    const e: Pt = [h[0] + ox, h[1]]
    return [a, [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2 + 4], e]
  }
  const up = (a: Pt, d: number): Pt[] => [a, [a[0] + d, a[1] - 22], [a[0] + d * 0.7, a[1] - 48]]
  if (mood === 'idle') {
    c.limb(to(sR, HAND.ball), w).limb([sL, [sL[0] - 7, sL[1] + 7]], w)
  } else if (mood === 'working') {
    c.limb(to(sR, HAND.key), w).limb([sL, [sL[0] + 9, sL[1] + 4]], w)
  } else if (mood === 'hungry') {
    c.limb(to(sR, HAND.bowl), w)
  } else if (mood === 'happy') c.limb(up(hL, -14), w).limb(up(hR, 14), w)
}

/** Feet: two little nubs. */
const feet = (c: Canvas, base: number, dx: number) => {
  for (const sx of [-1, 1]) {
    const x = PET_X + sx * dx
    c.outlined(ellipse(x, base - 9, 21, 9))
    for (const t of [-5, 6]) c.line(pl(x + t, base - 9, x + t, base - 3), 2)
  }
}

const TILT = {
  tuantuan: { idle: 6, working: 5, hungry: -6, happy: -4, sleepy: -9 },
  yaya: { idle: -5, working: 6, hungry: 5, happy: 4, sleepy: 8 },
  fangfang: { idle: 5, working: 4, hungry: -7, happy: -5, sleepy: -9 },
} satisfies Record<string, Record<PetMood, number>>

const GAZE: Record<PetMood, number> = { idle: 4, working: 4, hungry: 3, happy: 0, sleepy: 0 }

/** 团团: a round mochi of a cat with a cocked head, one floppy ear and a curly tail. */
function drawCat(c: Canvas, mood: PetMood, base: number, ox: number) {
  const cx = PET_X
  const sleepy = mood === 'sleepy'
  const rx = sleepy ? 84 : 80,
    ry = sleepy ? 58 : 74
  const cy = base - ry + 8,
    top = cy - ry
  const tilt = TILT.tuantuan[mood]
  const P = (dx: number, dy: number): Pt => [cx + dx, base + dy]
  const W = (dx: number, dy: number) => rot(cx, base, tilt, P(dx, dy))
  const tube = (pts: Pt[], w: number, tip = 0) => {
    const sp = spline(pts)
    c.line(sp, w).line(sp, w - 6, PAPER)
    if (tip) c.line(sp.slice(-tip), w)
  }
  // Curly tail behind the body: up when awake, limp when hungry.
  const tails: Record<PetMood, Pt[]> = {
    idle: [P(66, -40), P(98, -56), P(116, -88), P(108, -116), P(92, -118)],
    working: [P(66, -40), P(98, -48), P(116, -72), P(108, -96), P(94, -94)],
    hungry: [P(70, -40), P(86, -30), P(88, -14), P(82, -6)],
    happy: [P(66, -44), P(96, -64), P(108, -100), P(98, -128), P(108, -142)],
    sleepy: [P(76, -12), P(100, -8), P(118, -14), P(116, -28), P(104, -30)],
  }
  tube(tails[mood], 16, mood === 'hungry' ? 0 : 18)
  const body = subtract(ellipse(cx, cy, rx, ry), below(base))
  // Ears: round-tipped triangles; they flop outwards when the cat is sad or sleepy.
  const flop: Record<PetMood, [number, number]> = {
    idle: [20, 0],
    working: [0, 0],
    hungry: [26, 22],
    happy: [0, -6],
    sleepy: [30, 22],
  }
  const ears = [-1, 1].map((sx) => {
    const lean = flop[mood][sx < 0 ? 0 : 1]
    const piv: Pt = [cx + sx * 56, top + 44]
    return pl(cx + sx * 70, top + 52, cx + sx * 52, top - 4, cx + sx * 18, top + 18).map((p) =>
      rot(piv[0], piv[1], sx * lean, p),
    )
  })
  const ey = cy + 4
  c.xform(cx, base, tilt, 0, 0, () => {
    c.silhouette([body, ...ears.map((e) => grow(poly(e), 5))])
    for (const e of ears) {
      const q: Pt = [(e[0]![0] + e[1]![0] + e[2]![0]) / 3, (e[0]![1] + e[1]![1] + e[2]![1]) / 3]
      const inner = e.map(
        (p) => [q[0] + (p[0] - q[0]) * 0.55, q[1] + (p[1] - q[1]) * 0.55 - 4] as Pt,
      )
      c.fill(subtract(grow(poly(inner), 1), grow(body, 5)), INK)
    }
    for (const sx of [-1, 1]) {
      c.line(pl(cx + sx * (rx - 6), ey + 6, cx + sx * (rx + 14), ey + 1), 2)
      c.line(pl(cx + sx * (rx - 6), ey + 16, cx + sx * (rx + 14), ey + 20), 2)
    }
    face(c, mood, {
      cx,
      y: ey,
      dx: 38,
      ink: INK,
      paper: PAPER,
      mouth: 'cat',
      gaze: GAZE[mood],
    })
    c.fill(ellipse(cx, ey + 14, 5, 3.5), INK)
    cheeks(c, cx, ey + 21, 60)
    if (sleepy) snot(c, cx + 25, ey + 17)
  })
  if (sleepy) {
    // Paws tucked under the chin.
    for (const sx of [-1, 1]) c.outlined(ellipse(cx + sx * 30, base - 9, 22, 9))
    return
  }
  arms(c, mood, (sx, high) => W(sx * (rx - 4), high ? -66 : -26), ox, 15)
  feet(c, base, 44)
}

/** 芽芽: a round dumpling whose two leaves talk. */
function drawSprout(c: Canvas, mood: PetMood, base: number, ox: number) {
  const cx = PET_X
  const sleepy = mood === 'sleepy'
  const rx = sleepy ? 84 : 74,
    ry = sleepy ? 54 : 66
  const cy = base - ry + 8,
    top = cy - ry
  const tilt = TILT.yaya[mood]
  type LeafPose = [number, number, number]
  // Leaf poses: [start angle, end angle, length] for the left and the right leaf.
  const pose: Record<PetMood, [LeafPose, LeafPose]> = {
    idle: [
      [-30, -52, 52],
      [40, 78, 58],
    ],
    working: [
      [-2, 22, 50],
      [26, 52, 58],
    ],
    hungry: [
      [-95, -165, 46],
      [88, 150, 50],
    ],
    happy: [
      [-62, -95, 56],
      [58, 88, 60],
    ],
    sleepy: [
      [-3, -8, 50],
      [4, 12, 46],
    ],
  }
  const body = subtract(ellipse(cx, cy, rx, ry), below(base))
  const leaves = () =>
    pose[mood].forEach(([a0, a1, len]) => {
      const { shape, axis } = leaf([cx, top - 8], a0, a1, len, 17)
      c.outlined(shape).line(axis.slice(3, 21), 2)
    })
  const ey = cy + 4
  c.xform(cx, base, tilt, 0, 0, () => {
    c.line(pl(cx, top + 8, cx, top - 8), 6)
    if (mood !== 'hungry') leaves()
    c.outlined(body)
    if (mood === 'hungry') leaves()
    if (mood === 'working') {
      // Round glasses; the eyes are drawn inside them.
      for (const sx of [-1, 1]) c.outlined(circle(cx + sx * 38, ey, 21))
      c.line(pl(cx - 17, ey - 4, cx + 17, ey - 4), 3)
    }
    face(c, mood, {
      cx,
      y: ey,
      dx: 38,
      ink: INK,
      paper: PAPER,
      mouth: 'smile',
      brows: mood !== 'working',
      gaze: GAZE[mood],
    })
    cheeks(c, cx, ey + 22, 60)
    if (sleepy) snot(c, cx + 25, ey + 18)
  })
  if (sleepy) return
  arms(
    c,
    mood,
    (sx, high) => rot(cx, base, tilt, [cx + sx * (rx - 4), base - (high ? 60 : 26)]),
    ox,
    13,
  )
  feet(c, base, 40)
}

/** 方方: a small robot whose face is a black screen; the expression lives in white on it. */
function drawRobot(c: Canvas, mood: PetMood, base: number, ox: number) {
  const cx = PET_X
  const awake = mood !== 'sleepy' && mood !== 'hungry'
  const hy = base - 92
  const tilt = TILT.fangfang[mood]
  const sway = { idle: 6, working: 0, hungry: -9, happy: 8, sleepy: -11 }[mood]
  // Short body and feet first, then the arms, then the big head. Cheering arms go behind the head.
  if (mood === 'happy')
    for (const sx of [-1, 1])
      c.limb(
        [
          [cx + sx * 38, base - 58],
          [cx + sx * 68, base - 76],
          [cx + sx * 94, base - 104],
        ],
        12,
      )
  for (const sx of [-1, 1]) c.outlined(rrect(cx + sx * 18, base - 7, 14, 7, 5))
  c.outlined(rrect(cx, base - 31, 38, 18, 10, 14))
  for (const sx of [-1, 1]) c.fill(circle(cx + sx * 11, base - 31, 3.5), INK)
  c.xform(cx, base - 50, tilt, 0, 0, () => {
    // Antenna with a lamp; red while the robot has power.
    c.line(quad([cx, hy - 44], [cx + sway * 0.2, hy - 50], [cx + sway, hy - 56], 8), 5)
    c.outlined(circle(cx + sway, hy - 64, 9), 3, awake ? RED : PAPER)
    c.outlined(rrect(cx, hy, 74, 46, 28))
    for (const sx of [-1, 1]) {
      // Bolts on both sides of the head.
      c.outlined(rrect(cx + sx * 78, hy, 7, 15, 5))
      c.fill(circle(cx + sx * 78, hy, 3.5), INK)
    }
    c.fill(rrect(cx, hy, 62, 36, 22), INK)
    face(c, mood, {
      cx,
      y: hy - 4,
      dx: 31,
      ink: PAPER,
      paper: INK,
      robot: true,
      mouth: 'smile',
      gaze: GAZE[mood],
    })
    cheeks(c, cx, hy + 14, 50, 7, 4.5)
  })
  if (mood !== 'happy') arms(c, mood, (sx) => [cx + sx * 36, base - 32], ox, 12)
}

const PETS: Record<PetId, (c: Canvas, mood: PetMood, base: number, ox: number) => void> = {
  tuantuan: drawCat,
  yaya: drawSprout,
  fangfang: drawRobot,
}
/** The robot reaches less far, so its props sit a little closer. */
const PROP_SHIFT: Record<PetId, number> = { tuantuan: 0, yaya: 0, fangfang: -24 }

// ------------------------------------------------------------------- props
const zee = (c: Canvas, x: number, y: number, s: number) =>
  c.line(pl(x, y, x + s, y, x, y + s, x + s, y + s), 3.5)

/** Stomach rumble marks to the left of a hungry pet. */
function growl(c: Canvas, x: number, y: number) {
  for (const r of [14, 24]) c.line(arc(x + 34, y, r, r, 145, 215, 10), 3)
}

function drawProps(c: Canvas, mood: PetMood, ox: number) {
  const px = PET_X - ox // the pet's own column, whatever the props are shifted by
  if (mood === 'idle') {
    // A toy ball the pet is about to bat, and rolling marks.
    c.outlined(circle(226, 176, 21))
    c.line(pl(205, 176, 247, 176), 2).line(arc(226, 176, 9, 19, 0, 360, 32), 2)
    for (const r of [30, 39]) c.line(arc(226, 176, r, r, -30, 30, 8), 2.5)
  } else if (mood === 'working') {
    // A keyboard and a small monitor showing a terminal: title bar with lamps, then code.
    c.outlined(rrect(244, 190, 31, 7, 3))
    for (const x of [232, 242, 252, 262]) c.fill(circle(x, 190, 1.7), INK)
    for (const [x0, y0, x1, y1] of [
      [228, 171, 224, 164],
      [241, 171, 243, 162],
      [254, 172, 260, 166],
    ] as const)
      c.line(pl(x0, y0, x1, y1), 2)
    c.outlined(rrect(324, 128, 52, 42, 8)).fill(rrect(324, 102, 49, 15, 5, 0), INK)
    c.fill(circle(282, 102, 4.5), RED).fill(circle(294, 102, 3.5), PAPER)
    c.fill(circle(305, 102, 3.5), PAPER)
    c.line(pl(284, 116, 292, 122, 284, 128), 3).line(pl(300, 122, 328, 122), 3)
    for (const [x0, y, x1] of [
      [292, 136, 346],
      [292, 150, 322],
      [332, 150, 354],
    ] as const)
      c.line(pl(x0, y, x1, y), 3)
    c.fill(rrect(358, 150, 4, 7, 1), INK)
    c.outlined(rect(324, 175, 10, 14)).outlined(rrect(324, 190, 32, 7, 6, 3))
  } else if (mood === 'sleepy') {
    // A red crescent moon and drifting z's.
    c.fill(subtract(circle(240, 118, 22), circle(250, 109, 19)), RED)
    zee(c, 250, 82, 14)
    zee(c, 272, 58, 18)
    zee(c, 300, 28, 24)
  } else if (mood === 'happy') {
    c.fill(heart(250, 92, 34), RED).fill(heart(280, 118, 18), RED)
    for (const [x, y, r] of [
      [322, 56, 14],
      [338, 130, 16],
      [354, 84, 9],
      [20 - Math.min(ox, 0), 62, 12],
      [300, 160, 10],
    ] as const)
      c.fill(sparkle(x, y, r), INK)
    c.line(pl(px - 46, 193, px + 46, 193), 5) // shadow under the jump
    // Jump marks on both sides of the shadow.
    for (const sx of [-1, 1]) {
      c.line(pl(px + sx * 60, 190, px + sx * 78, 181), 2.5)
      c.line(pl(px + sx * 66, 194, px + sx * 88, 192), 2.5)
    }
  } else {
    // Stomach rumbles, a thought bubble with a red apple, and an empty bowl.
    growl(c, 0, 172)
    const bubble = union(
      circle(260, 116, 19),
      circle(282, 96, 23),
      circle(306, 114, 19),
      circle(283, 128, 19),
    )
    c.silhouette([bubble])
      .outlined(circle(236, 140, 7))
      .outlined(circle(224, 152, 4.5))
    const ax = 283,
      ay = 114
    const lobes = union(
      circle(ax - 8, ay + 1, 14),
      circle(ax + 8, ay + 1, 14),
      ellipse(ax, ay + 7, 20, 13),
    )
    c.fill(subtract(lobes, circle(ax, ay - 13, 5)), RED).line(pl(ax, ay - 8, ax + 3, ay - 21), 3)
    c.fill(grow(poly(pl(ax + 5, ay - 16, ax + 20, ay - 25, ax + 16, ay - 11)), 1.5), INK)
    c.line(arc(ax - 9, ay + 3, 8, 8, 200, 260, 6), 2.5, PAPER)
    c.outlined(intersect(ellipse(240, 170, 38, 27), below(170)))
    c.outlined(ellipse(240, 170, 44, 8)).fill(ellipse(240, 171, 33, 3.5), INK)
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
  const ox = PROP_SHIFT[id]
  canvas.xform(0, 0, 0, ox, 0, () => drawProps(canvas, mood, ox))
  // A happy pet is in mid-jump, feet off the ground.
  PETS[id](canvas, mood, mood === 'happy' ? GROUND - 18 : GROUND, ox)
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
