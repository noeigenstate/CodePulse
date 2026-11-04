# Active 0.0.31-font / native pixel grid

Production pages draw every glyph at 1:1. Chinese uses designed ZhengGeDianHei 16
or Fusion Pixel proportional 12; Latin and punctuation up to 32px use native
Terminus strikes. Only numeric heroes above 32px use pinned Noto Sans Bold outlines.
There is no runtime outline rasterizer, integer glyph enlargement, gray or dithering.

All Latin roles retain their 0.0.30 bold weight: BODY/META/STATE use native16b;
MICRO uses native16b Latin with Fusion12 CJK. Header temperature keeps bold16 in
the 56px available before the unchanged humidity icon, preserving `-40.0°C` in full.

One shared packing-time rule (`scripts/font-spacing.py`) adjusts Terminus records
for both atlases: U+0020 gets half its native advance, rounded half-up; U+00B7 gets
ink width + 4px, centered with 2px each side. Native16b uses 4px spaces and 6px dots;
native18b/20b uses 5/6px, native32b 8/7px. Bitmap rows are unchanged. Measurement,
drawing, circle fitting and line breaking consume these same records. Life sunset
adds a 4px spacer; holiday ranges use native32's 13px en dash. The earlier
narrow-column middle-dot text rewrite is removed.

| Role                                             | Chinese                   | Latin/digits               | Normal advances         |
| ------------------------------------------------ | ------------------------- | -------------------------- | ----------------------- |
| BODY                                             | ZhengGe16                 | Terminus16b                | 16 / 8px                |
| TITLE, DENSE_TITLE, USAGE_TITLE; life body/title | ZhengGe16                 | Terminus20b                | 16 / 10px               |
| BADGE, SMALL_BOLD, BRAND, SUMMARY                | Fusion12                  | Terminus16b                | 12 / 8px                |
| META, STATE; life compact labels                 | Fusion12                  | Terminus16b                | 12 / 8px                |
| NUMBER                                           | ZhengGe16                 | Terminus18b                | 16 / 10px               |
| MICRO (closed 207)                               | Fusion12                  | Terminus16b                | 12 / 8px                |
| DATE; life secondary numbers/commands            | ZhengGe16 fallback        | Terminus32b                | 16 / 16px               |
| USAGE_NUMBER                                     | Complete pixel16 fallback | Noto Bold40 numeric subset | Native variable advance |
| Life price/year/day hero                         | ZhengGe16 labels          | Noto Bold56 numeric subset | Native variable advance |
| Life weather hero                                | ZhengGe16 labels          | Noto Bold60 numeric subset | Native variable advance |

Fusion lacks 116 CJK characters in the project repertoire. Compact roles reserve
at least a 16px line box and use unmodified ZhengGe16 for them. An additional 22
symbols use the same fallback; 81 compatibility codepoints use native Unifont16.
The complete 16px base also uses 12 native Fusion symbols missing in ZhengGe/Terminus;
these are separately listed with the roles they affect.
All affected codepoints and roles are listed in
[`sources/font-grid-fallbacks.json`](sources/font-grid-fallbacks.json). The calendar
closed 207 needs **zero fallback**: native Fusion12 CJK and native bold16 Latin. Outside that closed
set MICRO retains the complete pixel16 fallback and the existing fit/ellipsis rules.
All 14 semantic faces retain all 7,752 project codepoints.

Terminus' U+2212 and U+2013 masks/metrics are identical; the renderer accepts math
minus through that alias without changing the project charset. Noto Sans Bold 2.008
has no U+2212 outline, so the large numeric subset uses its same-size U+2013 outline
for that codepoint. Neither path changes card text or scales a glyph.

The dev-only hero stage is pinned to FreeType 2.13.2 / freetype-py 2.5.1 (generated
with Python 3.12.10). It renders unhinted GRAY at 8x, box-averages aligned 8x8 target
cells, then applies a 50% coverage threshold. A deterministic single spur pass and
notch pass only accept edits preserving foreground 8-connectivity and background
4-connectivity/component counts. Counters cannot close and strokes cannot split.
Small-font bitmap rows retain the original BDF pixels. Only space/dot advances and
the dot's horizontal bearing use the shared compact-spacing rule above.

Regenerate from the repository root:

```powershell
python -B firmware/scripts/generate-native-font-masks.py --freetype-path <pinned-tools>
python -S firmware/scripts/generate-display-font.py --write-source
python -S firmware/scripts/generate-life-assets.py
python firmware/tests/test_bitmap_fonts.py
python firmware/tests/test_life_assets.py
python firmware/tests/test_font_grid_sources.py --freetype-path <pinned-tools>
```

The last two packing stages and ordinary bitmap checks need only stdlib plus the
checked-in `grid-native-masks` cache. Font files, exact hashes and all verbatim
licenses are pinned by `sources/font-grid-sources.json`, source-mask metadata and
[SOURCE.txt](SOURCE.txt). Original font sources/licenses remain available; unused
Noto SC mask caches are retired and no SC outline table/notice is linked or shipped.

The main atlas is **230,494 compressed / 567,665 expanded bytes**, versus
309,408 / 578,597 previously. `scripts/test-font-budget.py` includes the separate
life renderer/constants and supports an accurately named saved-source baseline.
Host COFF estimates do not establish ESP32 application-partition headroom; the CI
target link/map remains required. Previous 0.0.29/0.0.30 pixel baselines are retained;
the explicit 0.0.31 baselines freeze the new masks, with independent life geometry
and unchanged icon checks. Before/after evidence is under `.tmpshots/font-grid/`.

## Historical Scheme C / native Noto MONO (superseded)

The active hierarchy uses Noto Sans Bold 2.008 and Noto Sans SC Regular 2.004, rasterized natively at each target size. Body is SC14, title/caption SC16; calendar labels use sparse native SC12 with the complete body14 fallback. All 14 semantic layers can draw 7,752 codepoints. Ordinary pages do not enlarge glyphs.

The approved `life` B layout (0.0.30-life) is the explicit exception for numeric heroes:
its pinned Terminus Bold32 BDF subset is drawn at native 32px for secondary numbers
and exact integer 2x for heroes. Chinese stays native SC14/16; no black outline,
antialiasing or dithering. `python scripts/generate-life-assets.py --check` verifies
the original BDF hash, generated subset and exact approved 2bpp icons. The 14 Noto
semantic tables and their fallback policy are unchanged. Terminus attribution/OFL
ships with both preview renderers; see SOURCE.txt and `licenses/Terminus-OFL.txt`.

Source-stage FreeType is isolated in `scripts/generate-native-font-masks.py`; `python -S scripts/generate-display-font.py --write-source` rebuilds the atlas using only stdlib and checked-in masks. Validate with `python tests/test_bitmap_fonts.py`. Exact versions, source hashes, native-size policy and licenses are in [SOURCE.txt](SOURCE.txt).

`scripts/generate-calendar-font-charset.mjs --module <desktop calendar directory> --check` verifies the pinned closed vocabulary against all 73,414 dates in 1900-2100. The cached JSON makes ordinary atlas builds independent of Node and the desktop checkout. Approved stress labels retain native12 too. Other micro text uses the existing native body14 glyphs; custom four-character labels may require the existing width truncation. All other layers and the approved rendered images retain identical pixels.

Two shared complete tables and five sparse tables pack to 309,408 compressed bytes / 578,597 PSRAM bytes. See `scripts/test-font-budget.py --help` for the reproducible three-unit host size comparison; an ESP32-S3 link/map is still required for the final application size.

Historical notes follow.

# Historical pixel hierarchy (initial 0.0.29)

Unifont 16px titles, Fusion Pixel proportional 12px with 254 original Noto fallback glyphs, and integer enlarged numbers. All 12 semantic layers cover 7,752 codepoints. Regenerate offline with `python scripts/generate-display-font.py --write-source`; verify with `python tests/test_bitmap_fonts.py`. Sources, exact hashes and verbatim license paths are in [SOURCE.txt](SOURCE.txt).

The following notes describe retained historical sources.

# CodePulse display fonts

The active atlas derives from the pinned Noto Sans SC source documented in
SOURCE.txt, under SIL OFL 1.1 (LICENSE.txt). Current hierarchy is 20/14/12 px:
titles are largest/bold; subordinate labels, numbers and toolbar follow the
accepted HUD hierarchy. The packed 1-bit masks retain source bearings, baselines
and fractional Latin spacing. No runtime system font installation is required.

Regenerate the current header from the checked-in atlas with:

    python scripts/generate-hierarchy-font.py
    python tests/test_bitmap_fonts.py

Inspect the generator's help before changing font sources. Re-rasterizing needs
the pinned font file and Pillow; ordinary packing uses the Python standard
library. Rebuild both desktop Wasm previews after any pixel-affecting change.

The BDF/HEX files and licenses for Terminus, ZhengGeDianHei and Unifont preserve
historical comparison sources. generate-display-font.py delegates to the current hierarchy generator.
generate-title-font.py is the historical title-only BDF generator.
SOURCE.txt records their chronology; the leading current entry takes precedence.
