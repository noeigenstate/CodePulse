# Active Scheme C / native Noto MONO

The active hierarchy uses Noto Sans Bold 2.008 and Noto Sans SC Regular 2.004, rasterized natively at each target size. Body is SC14, title/caption SC16; calendar labels use sparse native SC12 with the complete body14 fallback. All 14 semantic layers can draw 7,752 codepoints. Runtime pages do not enlarge glyphs.

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
