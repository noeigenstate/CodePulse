# Firmware attribution and license scope

CodePulse-owned firmware source is distributed under the repository's
[MIT License](../LICENSE). This does not replace third-party notices:

- ESP-IDF **6.0.1** and its components retain their upstream licenses. External
  dependencies are resolved by `dependencies.lock` from the public Espressif
  registry, not copied from a private server. Preserve notices when distributing binaries.
- cJSON **1.7.19~2** and mDNS **1.11.1** are locked in `dependencies.lock`.
  `managed_components/` is generated and untracked; inspect those components'
  upstream license files when packaging a firmware binary.
- `tests/vendor/miniz/` retains its [upstream LICENSE](tests/vendor/miniz/LICENSE).
  Its decoder is also used by the compressed font renderer.
- Optional audio adapts the Xiaozhi/LumaDesk I2S/PDM path under the preserved
  [MIT notices](THIRD-PARTY-NOTICES-AUDIO.txt).
- Fonts, masks and subsets retain their own licenses and attributions in
  [fonts/SOURCE.txt](fonts/SOURCE.txt) and `fonts/licenses/`. Current Noto faces
  use their OFL notices; the preserved Unifont sources include the offered
  OFL license and original license text. Historical font sources and notices
  remain available for reproduction; they are not all embedded in the current image.
- Native grid fonts use ZhengGeDianHei16, Fusion Pixel proportional12 (including
  all four original bundled font notices), Terminus12n/16n/16b/18b/20b/32b and
  Unifont compatibility glyphs. Numeric heroes above 32px use native Noto Sans Bold.
  Source hashes and verbatim OFL/license records are in `fonts/sources/font-grid-sources.json`.
  FreeType is development-only; no outline rasterizer is linked into firmware/Wasm.
  Retired Noto SC sources/licenses remain historical; its outline tables are not shipped.

The Wasm build produces `THIRD-PARTY-FONTS.txt` containing font and linked-code
notices. `scripts/sync-device-preview.ps1` at the root copies it to both UI
asset directories and both public notice resources. Do not relabel font files
as MIT, strip reserved names or omit original licenses from binary distributions.

Hardware design licenses are assigned by their contributors under `hardware/`;
this software notice is not a hardware manufacturing or license declaration.
