"""E-paper picture bench: variants x images -> contact sheet + metrics.

usage: python bench.py <bench-dir> <round-name> [variant ...]
  <bench-dir>/set/*  test pictures (keep them local; never commit personal pictures)
  writes <bench-dir>/<round-name>/{sheet.png, metrics.json, <image>-<variant>.png}
Panel: 384x208 picture area, black/white/red, red limited to one rectangle w*h/8 <= 3072 bytes.
'a2' mirrors the shipped converter in apps/desktop/src/main/ambient-image.ts; keep them in step.
Needs numpy, scipy, Pillow.
"""
import sys, json, glob, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

AW, AH, RED_MAX = 384, 208, 3072
RED_INK = np.array([0.78, 0.12, 0.16])  # display colour of red ink
RED_LUMA = 0.42
BAYER = (np.array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]).reshape(4, 4) + 0.5) / 16


def load(path):
    im = Image.open(path).convert('RGB')
    s = min(AW / im.width, AH / im.height)
    w, h = max(1, int(im.width * s)), max(1, int(im.height * s))
    return np.asarray(im.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255


def luma(rgb):
    return rgb @ np.array([0.299, 0.587, 0.114], np.float32)


def gblur(x, s):
    return ndi.gaussian_filter(x, s, mode='nearest')


# ---------- tone ----------
def stretch(L):
    lo, hi = np.percentile(L, 1), np.percentile(L, 99.5)
    if hi - lo < 0.05:
        return L.copy()
    return np.clip((L - lo) / (hi - lo), 0, 1)


def gamma_mid(x, target=0.5):
    med = np.median(x)
    g = np.clip(np.log(target) / np.log(max(med, 1e-3)), 0.35, 1.6)
    return x ** g


def local_contrast(x, amount=0.6, sigma=12):
    return np.clip(x + amount * (x - gblur(x, sigma)), 0, 1)


def sharpen(x, amount=1.2, sigma=1.2):
    return np.clip(x + amount * (x - gblur(x, sigma)), 0, 1)


def clahe(x, tiles=(3, 6), clip=2.5, bins=256):
    """Contrast-limited adaptive histogram equalisation with bilinear blending of tile maps."""
    h, w = x.shape
    ty, tx = tiles
    maps = np.zeros((ty, tx, bins), np.float32)
    q = np.clip((x * (bins - 1)).astype(int), 0, bins - 1)
    for j in range(ty):
        for i in range(tx):
            t = q[j * h // ty:(j + 1) * h // ty, i * w // tx:(i + 1) * w // tx]
            hist = np.bincount(t.ravel(), minlength=bins).astype(np.float32)
            limit = clip * t.size / bins
            excess = np.maximum(hist - limit, 0).sum()
            hist = np.minimum(hist, limit) + excess / bins
            cdf = hist.cumsum()
            maps[j, i] = (cdf - cdf[0]) / max(cdf[-1] - cdf[0], 1)
    cy = (np.arange(h) + 0.5) / h * ty - 0.5
    cx = (np.arange(w) + 0.5) / w * tx - 0.5
    y0 = np.clip(np.floor(cy).astype(int), 0, ty - 1); y1 = np.clip(y0 + 1, 0, ty - 1)
    x0 = np.clip(np.floor(cx).astype(int), 0, tx - 1); x1 = np.clip(x0 + 1, 0, tx - 1)
    fy = np.clip(cy - y0, 0, 1)[:, None]; fx = np.clip(cx - x0, 0, 1)[None, :]
    Y0, X0, Y1, X1 = y0[:, None], x0[None, :], y1[:, None], x1[None, :]
    v = (maps[Y0, X0, q] * (1 - fy) * (1 - fx) + maps[Y0, X1, q] * (1 - fy) * fx +
         maps[Y1, X0, q] * fy * (1 - fx) + maps[Y1, X1, q] * fy * fx)
    return v


def outlines(x, sigma=0.9, k=1.6, strength=None):
    """XDoG-style dark lines on the dark side of edges; returns a bool mask."""
    d = gblur(x, sigma) - gblur(x, sigma * k)
    t = strength if strength is not None else max(0.035, np.percentile(np.abs(d), 92))
    return d < -t


# ---------- red ----------
def redness(rgb, max_hue=16, min_sat=0.5):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1); c = mx - rgb.min(-1)
    hue = np.where((r >= mx - 1e-6) & (c > 1e-3), (g - b) / np.maximum(c, 1e-3) * 60, 999)
    hw = np.clip((max_hue + 2 - np.abs(hue + 2)) / 10, 0, 1)
    sat = c / np.maximum(mx, 1e-3)
    return hw * np.clip((sat - min_sat) / 0.3, 0, 1) * np.clip((mx - 0.12) / 0.2, 0, 1)


def red_rect(score, coverage=0.0):
    total = score.sum()
    if total < 120:
        return None
    sat = np.pad(score.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    best = None
    for w in range(64, AW + 1, 8):
        h = min(AH, RED_MAX * 8 // w)
        ys = np.arange(0, AH - h + 1, 4); xs = np.arange(0, AW - w + 1, 8)
        s = sat[ys[:, None] + h, xs[None, :] + w] - sat[ys[:, None], xs[None, :] + w] - sat[ys[:, None] + h, xs[None, :]] + sat[ys[:, None], xs[None, :]]
        j, i = np.unravel_index(np.argmax(s), s.shape)
        if best is None or s[j, i] > best[0]:
            best = (s[j, i], xs[i], ys[j], w, h)
    if best[0] < 120 or best[0] < coverage * total:
        return None  # red would be visibly cut off at the rectangle edge
    return best[1:]


# ---------- dither ----------
def diffuse(x, red=None, kernel='atkinson', clamp_err=None):
    x = x.astype(np.float64).copy(); h, w = x.shape
    black = np.zeros((h, w), bool); redp = np.zeros((h, w), bool)
    if kernel == 'atkinson':
        taps = [((0, 1), 1 / 8), ((0, 2), 1 / 8), ((1, -1), 1 / 8), ((1, 0), 1 / 8), ((1, 1), 1 / 8), ((2, 0), 1 / 8)]
    else:  # floyd-steinberg
        taps = [((0, 1), 7 / 16), ((1, -1), 3 / 16), ((1, 0), 5 / 16), ((1, 1), 1 / 16)]
    for y in range(h):
        fwd = y % 2 == 0; rng = range(w) if fwd else range(w - 1, -1, -1); d = 1 if fwd else -1
        for i in rng:
            v = x[y, i]
            if red is not None and red[y, i]:
                out = RED_LUMA; redp[y, i] = True
            else:
                out = 0.0 if v < 0.5 else 1.0; black[y, i] = out == 0.0
            e = v - out
            if clamp_err is not None:
                e = max(-clamp_err, min(clamp_err, e))
            for (dy, dx), f in taps:
                yy, xx = y + dy, i + dx * d
                if 0 <= yy < h and 0 <= xx < w:
                    x[yy, xx] += e * f
    return black, redp


def red_mask(m, rect, shape, off):
    if rect is None:
        return None
    rx, ry, rw, rh = rect; oy, ox = off; h, w = shape
    t = BAYER[np.arange(h)[:, None] % 4, np.arange(w)[None, :] % 4] * 0.9
    mask = m > t
    box = np.zeros((h, w), bool)
    box[max(0, ry - oy):max(0, ry - oy + rh), max(0, rx - ox):max(0, rx - ox + rw)] = True
    return mask & box


# ---------- variants ----------
def v1(rgb, L, red=True):
    """Shipped in 75d0c25: stretch, median->0.5, local 0.6, sharpen 1.2, Atkinson, red hue<=16."""
    x = sharpen(local_contrast(gamma_mid(stretch(L))))
    return x, (redness(rgb) if red else None), dict(kernel='atkinson')


def v2(rgb, L, red=True):
    """v1 + light denoise + XDoG outlines; red only if the rectangle holds >=75% of the red."""
    x = sharpen(local_contrast(gamma_mid(stretch(ndi.median_filter(L, 3)))), 0.8)
    return x, (redness(rgb) if red else None), dict(kernel='atkinson', lines=outlines(gamma_mid(stretch(L))), coverage=0.75)


def v3(rgb, L, red=True):
    """CLAHE local equalisation blended 60/40 with v1 tone, Floyd-Steinberg with clamped error, outlines."""
    base = gamma_mid(stretch(L))
    x = np.clip(0.6 * clahe(base) + 0.4 * base, 0, 1)
    x = sharpen(x, 0.8)
    return x, (redness(rgb) if red else None), dict(kernel='fs', clamp=0.35, lines=outlines(base), coverage=0.75)


def v4(rgb, L, red=True):
    """v2 tone, wider red (orange-red up to hue 28, sat>=0.55) for warm subjects."""
    x, _, o = v2(rgb, L, red)
    return x, (redness(rgb, 28, 0.55) if red else None), o


def v5(rgb, L, red=True):
    """Lighter target (median->0.58) + v3 CLAHE blend + outlines; less ink overall."""
    base = gamma_mid(stretch(L), 0.58)
    x = sharpen(np.clip(0.5 * clahe(base) + 0.5 * base, 0, 1), 0.8)
    return x, (redness(rgb) if red else None), dict(kernel='atkinson', lines=outlines(base), coverage=0.75)


VARIANTS = {'v1': v1, 'v2': v2, 'v3': v3, 'v4': v4, 'v5': v5}


def render(rgb, variant):
    L = luma(rgb); h, w = L.shape
    oy, ox = (AH - h) // 2, (AW - w) // 2
    x, m, o = VARIANTS[variant](rgb, L)
    rect = None; rmask = None
    if m is not None:
        full = np.zeros((AH, AW), np.float32); full[oy:oy + h, ox:ox + w] = m
        rect = red_rect(full, o.get('coverage', 0.0))
        rmask = red_mask(m, rect, (h, w), (oy, ox))
    if 'lines' in o:
        x = np.where(o['lines'] & ~(rmask if rmask is not None else np.zeros_like(o['lines'])), np.minimum(x, 0.0), x)
    black, redp = diffuse(x, rmask, o['kernel'], o.get('clamp'))
    if 'lines' in o:
        black |= o['lines'] & ~redp
    out = np.ones((AH, AW, 3), np.float32)
    area = out[oy:oy + h, ox:ox + w]
    area[black] = 0; area[redp & ~black] = RED_INK
    return out, black, redp, rect, (oy, ox, h, w)


def metrics(rgb, out, black, redp):
    """structure: SSIM contrast-structure term between eye-blurred output and source luma (detail kept);
    ink: black share; red: red share."""
    L = luma(rgb)
    oy, ox = (AH - L.shape[0]) // 2, (AW - L.shape[1]) // 2
    o = luma(out)[oy:oy + L.shape[0], ox:ox + L.shape[1]]
    a, b = gblur(o, 1.5), gblur(L, 1.5)
    s = 3.0
    ma, mb = gblur(a, s), gblur(b, s)
    va = gblur(a * a, s) - ma * ma; vb = gblur(b * b, s) - mb * mb; cov = gblur(a * b, s) - ma * mb
    C2 = (0.03) ** 2
    cs = ((2 * cov + C2) / (va + vb + C2)).mean()
    return dict(structure=round(float(cs), 3), ink=round(float(black.mean()), 3), red=round(float(redp.mean()), 3))


def main():
    bench = sys.argv[1]; name = sys.argv[2]; variants = sys.argv[3:] or list(VARIANTS)
    files = sorted(glob.glob(os.path.join(bench, 'set', '*')))
    out_dir = os.path.join(bench, name); os.makedirs(out_dir, exist_ok=True)
    try:
        font = ImageFont.truetype('msyh.ttc', 15)  # CJK labels on Windows
    except OSError:
        font = ImageFont.load_default()
    Z = 2; cw, ch = AW * Z, AH * Z
    sheet = Image.new('RGB', ((len(variants) + 1) * (cw + 10) + 10, len(files) * (ch + 34) + 40), (232, 232, 232))
    d = ImageDraw.Draw(sheet)
    d.text((10, 10), '原图', font=font, fill=(0, 0, 0))
    for k, v in enumerate(variants):
        d.text((10 + (k + 1) * (cw + 10), 10), v + ' · ' + VARIANTS[v].__doc__.strip().split('\n')[0][:70], font=font, fill=(0, 0, 0))
    report = {}
    for r, f in enumerate(files):
        rgb = load(f); y = 40 + r * (ch + 34)
        src = Image.new('RGB', (AW, AH), 'white')
        src.paste(Image.fromarray((rgb * 255).astype(np.uint8)), ((AW - rgb.shape[1]) // 2, (AH - rgb.shape[0]) // 2))
        sheet.paste(src.resize((cw, ch), Image.LANCZOS), (10, y))
        d.text((10, y + ch + 4), os.path.basename(f), font=font, fill=(0, 0, 0))
        for k, v in enumerate(variants):
            out, black, redp, rect, _ = render(rgb, v)
            m = metrics(rgb, out, black, redp); report.setdefault(v, {})[os.path.basename(f)] = m
            im = Image.fromarray((out * 255).astype(np.uint8))
            im.save(os.path.join(out_dir, f'{os.path.splitext(os.path.basename(f))[0]}-{v}.png'))
            x = 10 + (k + 1) * (cw + 10)
            sheet.paste(im.resize((cw, ch), Image.NEAREST), (x, y))
            d.text((x, y + ch + 4), f"细节 {m['structure']}  黑 {m['ink']:.0%}  红 {m['red']:.1%}" + (f"  红框 {rect[2]}×{rect[3]}" if rect else ''), font=font, fill=(0, 0, 0))
    sheet.save(os.path.join(out_dir, 'sheet.png'))
    summary = {v: {k: round(float(np.mean([m[k] for m in per.values()])), 3) for k in ('structure', 'ink', 'red')} for v, per in report.items()}
    json.dump(dict(per_image=report, mean=summary), open(os.path.join(out_dir, 'metrics.json'), 'w'), indent=1)
    for v, s in summary.items():
        print(v, s)



# ---------- round 2: keep A's look, fix its weak spots ----------
def toe_shoulder(x, toe=0.15, shoulder=0.75, top=0.9):
    """Final roll-off: near-black shadows get sparse light dots (texture), near-white areas (faces)
    get a few dots of shading. Exactly white stays white, so plain backgrounds stay clean."""
    y = x.copy()
    lo = x < toe
    y[lo] = toe * 0.25 + x[lo] * 0.75
    mid = (x > shoulder) & (x < 0.995)
    y[mid] = shoulder + (x[mid] - shoulder) / (0.995 - shoulder) * (top - shoulder)
    return y


def a2(rgb, L, red=True):
    """A + toe/shoulder roll-off (faces keep shading, shadows keep texture)."""
    x = toe_shoulder(sharpen(local_contrast(gamma_mid(stretch(L)))))
    return x, (redness(rgb) if red else None), dict(kernel='atkinson')


def a3(rgb, L, red=True):
    """A2 + gentler fine sharpening on a lightly denoised image (less grain)."""
    x = toe_shoulder(sharpen(local_contrast(gamma_mid(stretch(ndi.median_filter(L, 3)))), 0.8))
    return x, (redness(rgb) if red else None), dict(kernel='atkinson')


def a4(rgb, L, red=True):
    """A2 + red only when one rectangle holds >=75% of the red (no cut-off), hue up to 22."""
    x = toe_shoulder(sharpen(local_contrast(gamma_mid(stretch(L)))))
    return x, (redness(rgb, 22, 0.5) if red else None), dict(kernel='atkinson', coverage=0.75)


VARIANTS.update({'a1': v1, 'a2': a2, 'a3': a3, 'a4': a4})


if __name__ == '__main__':
    main()
