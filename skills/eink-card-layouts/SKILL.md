---
name: eink-card-layouts
description: Use when adding or changing a structured e-paper card layout (the `layout: "life"` kinds such as concept, prompt, hn, weather) or the built-in concept/prompt content, or when large text on the 400×300 panel looks jagged. Covers the protocol touch points, the native 32px CJK strike, punctuation folding, and the check commands.
---

# Structured card layouts on the 400×300 panel

## Rules the user set

- **No integer upscaling, ever.** A 16px face drawn at 2× shows 2px stairs on diagonals, and the user rejects
  it. Large CJK text comes from the native 32px strike (`firmware/main/card_hero.generated.h`): Noto Sans SC
  rendered at 32px, 8× supersampled, with a 3/8px outline and a 50% threshold.
- Show the user a mockup rendered by the real renderer before building. To make one, copy `firmware/` to the
  scratchpad, change only that copy, and build it with `scripts/build-preview.py`.

## Adding a life kind (protocol touch points)

1. Add a struct and an enum value to `firmware/main/codepulse_life.h`.
2. In `codepulse_protocol.c` `parse_life`, add the kind name to `kinds`, raise the count, and parse every field.
   - Every key is required. Use `""` for optional values.
   - `test-life.mjs` deletes each key in turn and expects the text fallback.
3. In `life_dashboard.c`:
   - add the kind to `supported()`, so glyph coverage falls back as one unit;
   - render it inside rows 31–262 only;
   - never draw red over black: the tests require `black | red == 255`.
4. In `packages/shared/src/types/life.ts`, add the type, the limits in `normalizeDeviceLife`, and the copied keys.
5. In `apps/desktop/src/main/ambient-rules.ts` `deviceCard`, send the kind only with its own card kind.
6. Add a fixture to `firmware/preview/make-life-fixtures.mjs`, then run `node preview/make-life-fixtures.mjs --write`.
   Add the name to the lists in `test-life.mjs` and `render-life.mjs`. Document the kind in `docs/device-api-v1.md`.

## Punctuation

`deviceText()` folds full-width forms (，？：) to ASCII. Two things guard against that:

- For Chinese prose (`concept`, `prompt`), `deviceLife()` keeps `，：；？！（）`.
- The 32px strike maps ASCII punctuation to its full-width glyph.

If a new prose kind shows `,` crammed between Chinese characters, add it to the `keepWide` kinds in
`device-life.ts`.

## New characters in a 32px line

1. Add the characters to `firmware/fonts/sources/card-hero-charset.txt`.
2. Run `python firmware/scripts/generate-card-hero.py --rasterize`. This step needs Pillow. It loads the font from
   bytes because FreeType cannot open non-ASCII paths.
3. `tests/ambient-reading.test.ts` lists any character that is still missing.

A line with an unknown character, or one wider than 376px, falls back to the native 16px face. That keeps it
readable, but it is not what the user approved.

## Checks (all must pass)

```powershell
powershell -File scripts/sync-device-preview.ps1 -Zig <zig-0.13.0>/zig.exe   # rebuilds desktop and HUD assets
node scripts/check-firmware-preview.mjs
powershell -File firmware/scripts/test-preview.ps1 -Zig <zig>/zig.exe -Output .tmpshots/fw-preview-check
powershell -File firmware/scripts/test-host.ps1 -Output .tmpshots/fw-host
node tests/run-tests.mjs; pnpm typecheck; pnpm lint
```

- `test-preview.ps1` freezes the old life pixels and the reading-card pixels. After a reviewed change, re-record
  with `python firmware/preview/check-life.py <out>/life --update-reading`.
- Run the Python tests without `-I`. Some of them read UTF-8 sources and need the UTF-8 mode set by the environment.
- Pixels in the desktop preview are not proof that the device works. Flash only after the user confirms.
