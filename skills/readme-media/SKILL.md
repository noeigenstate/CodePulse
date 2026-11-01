---
name: readme-media
description: Use when adding or updating images, animations or videos for README.md / README.zh-CN.md (product demos, hardware tours); covers GitHub rendering limits, the HTML-to-video pipeline and bilingual README formatting.
---

# README media

## GitHub limits

- A repo-relative `<video>` does not play in a README. Show an **animated WebP** inline and link the MP4 beside it.
- GIF is too heavy for photo-like frames: a 28 s board tour was 8–10 MB as GIF, 3.5 MB as WebP (960 px, 15 fps, quality 60).
- Keep each inline asset under about 5 MB. Repo-relative paths with Chinese file names render, but link-check them.

## Pipeline (tested)

1. Write one HTML page at 1280×720 with a pure `render(t)` function that sets every style from the time `t`. Avoid CSS animations, so frames are deterministic.
2. Install `puppeteer-core` in a scratch directory (not the repo) and point it at the system Chrome. Load the page from a `file://` path, then call `render(i / 30)` and take a screenshot for each frame.
3. Encode:

   ```bash
   ffmpeg -framerate 30 -i f%05d.png -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart out.mp4
   ffmpeg -framerate 30 -i f%05d.png -vf "fps=15,scale=960:-1:flags=lanczos" -c:v libwebp_anim -quality 60 -compression_level 6 -loop 0 out.webp
   ```

4. Check sample frames by eye before encoding: callout positions, text overflow and the last frame's claims.
5. Follow the ui-standard skill for the look: show named concepts for a restyle and let the user pick, then measure each
   scene from computed styles (spacing on the 2–64 scale, at most 3 weights, second font size at most 0.8× the largest,
   few radii) and have another model accept sample frames before the full render.

Put generated media in `docs/hardware/` or `docs/screenshots/`, and keep design exports under `hardware/<board>/<revision>/exports/`.

## Look

- Use a light background: GitHub shows READMEs on a white page, and a dark video reads as a black block there.
- Small accent text on a light background needs a dark accent (teal `#0b7a68` reaches 4.5:1; `#0fa58e` does not).
- In a grayscale blur check, a dark-blue PCB vanishes on a blue background; keep the board darker than its surroundings.
- Overlapping cards hide each other's captions: put captions on each card's outer side and stack the middle cards on top.
- Remove black backgrounds from EDA exports with `colorkey` before placing them on a light background.

## README text

- Do not soft-wrap Chinese prose: GitHub renders each line break as a space. Keep every Chinese paragraph on one line.
- Keep README.md and README.zh-CN.md section for section, and run `prettier --check` on both (`pnpm lint` covers `*.md`).
- Do not claim more than the files show: say "exports" when the source or BOM is missing, and "not verified" until it is tested on the device.
