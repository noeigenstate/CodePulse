---
name: eink-picture-tuning
description: Use when changing how photos, memes or imported pictures are converted for the 400×300 black/white/red e-paper panel (apps/desktop/src/main/ambient-image.ts), or when a picture on the panel looks too dark, loses small figures, or uses red badly. Covers the techniques that work, the bench for comparing variants, and the user-acceptance loop.
---

# Tuning pictures for the black/white/red panel

The panel has no grey. Every pixel is black, white or red, and red is limited by the protocol to one
rectangle with `w*h/8 <= 3072` bytes (x and w multiples of 8; `docs/device-api-v1.md`, "Red ink").
The picture area is 384×208.

## What works (accepted by the user, 2026-11-03)

Pipeline in `packPicture` (`ambient-image.ts`), in this order:

1. **Stretch to the picture's own range.** Use the 1st and 99.5th luminance percentiles. Skip the stretch when the
   range is under 0.05, so a logo on white keeps its tone.
2. **Lift the median to 0.5.** Use a gamma clamped to 0.35–1.6. A fixed threshold turned a dim indoor photo into 94%
   black ink; this alone brings it to about 47%.
3. **Add local contrast,** `x + 0.6·(x − blur σ12)`, then **fine sharpening,** `x + 1.2·(x − blur σ1.2)`. Small faces
   keep their shape.
4. **Apply the final roll-off after the contrast steps** (step 3 undoes it if done earlier):
   - near-white 0.75–0.995 maps to 0.75–0.90, so lit faces get a few dots of shading;
   - near-black is lifted (`0.0375 + 0.75v` below 0.15), so shadows keep texture;
   - exactly white stays white, so plain backgrounds get no stray dots.
5. **Dither with serpentine Atkinson diffusion** (6/8 of the error). It is lighter and crisper than Floyd–Steinberg or
   a Bayer threshold.
6. **Red, for personal pictures only.**
   - Use red only for saturated reds: hue about 0–16°, saturation ≥ 0.5, value ≥ 0.12.
   - Pick the protocol-sized rectangle that holds the most red, using a summed-area table over all widths 64–384.
   - Use an ordered threshold on redness inside that rectangle, so red reads as a texture.
   - Red never overlaps black, and counts as luminance 0.42 in the diffusion.
   - Memes stay black/white, because red forces a ~16 s flashing full refresh on every rotation.

## What the user rejected

The user prefers clean, high-contrast results over "photographic" ones.

- **CLAHE local equalization + Floyd–Steinberg + XDoG outlines** (bench `v3`). It scored best on the detail metric
  (0.772 vs 0.714) but looked grey and grainy; the user picked A over it. Don't trust the metric over the user's eye.
- **Lighter target (median → 0.58) + outlines** (`v5`). Not preferred either.
- **Widening red to hue ≤ 22–28°** (`a4`, `v4`). Skin and warm-lit faces get red dots. A warm subject (a red panda)
  needs a separate rule; don't widen the global hue.
- **A roll-off placed before the contrast steps.** Only ~5% of pixels change, so it is invisible.

## Bench and acceptance loop

1. Put 6–10 representative pictures in `<scratch>/bench/set/`:
   - a dim group photo;
   - small figures in a landscape;
   - a red object on white;
   - an orange or red animal;
   - a portrait;
   - low-contrast mist.

   Keep them local. Never commit the user's pictures.

2. Add variants as functions in `scripts/bench.py` (`VARIANTS[...]`). Each returns `(tone, redness, options)`.
3. Run `python skills/eink-picture-tuning/scripts/bench.py <scratch>/bench r<N> a2 <new variants>`. It writes the
   following to `<scratch>/bench/r<N>/`:
   - `sheet.png`: the original plus each variant at 2×;
   - `metrics.json`: `structure` (SSIM contrast-structure of the eye-blurred output, i.e. detail kept), `ink`
     (black share of the picture) and `red`.
4. Show the user a compact sheet with the original, the current version and 2–3 candidates, labelled A/B/C, on 4–5
   rows. Say in one line what each changes and what to look at. **The user decides; the metric only ranks candidates
   for the sheet.**
5. Port the winner to `ambient-image.ts` and keep `a2` (or its successor) in the bench in step. Then:
   - check parity by bundling the TS with esbuild and running it on the same resized BGRA input; the bench's `ink`
     is a share of the picture area, while the app's packed plane is 384×208, so scale by `w·h/(384·208)`;
   - extend `tests/ambient-picture.test.ts`;
   - check in the app: `window.codepulse.importAmbientImage(bytes, name)` over CDP, then the 我的图片 preview.
6. Pictures already imported keep their old conversion; only the converted planes are stored. Tell the user to
   re-import, and remove any test copies you added yourself.

## Limits worth raising with the user

- **Red is cut at the rectangle edge** for subjects larger than 3 KB of red. Full-picture red needs a firmware
  protocol change: a larger `red` limit and the 32,000-byte status budget in `withAmbient` (`ambient-rules.ts`).
  It then needs a flash. Ask before starting.
- The desktop preview magnifies 2–3×. Judge with the preview's 「实物大小」 view too.
