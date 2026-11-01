# First public firmware import — 2026-11-01

Firmware is now ordinary source under `firmware/` in CodePulse. The initial
import uses a reviewed snapshot, not an unrelated-history merge, submodule,
private GitLab dependency or directory copy of a developer's working tree.

## Reconciled baselines

- Product: `df9b2c7607ceef33337f178c89c04f564e8c1b27`, including the remote
  calendar/native-font/pet work and the local desk assistant merge.
- Firmware: `9eccaa8c0d248fed5993b97a250e5361854be27f`, the final reviewed
  calendar/font branch, which includes the previous main checkpoint
  `42805963650fbd0bf51025e5e86bc1882ceb5ce9` (todos, gated audio and pixel pets).
- Runtime source version: **0.0.29-calendar**. Existing committed desktop/HUD
  preview: SHA256 `957f5468bcda8e3dca884f0d9aeada4ceaa5b110e859230ed9765ceaba5a17e3`.

All production `main/` files, fonts and preview sources come from that exact
firmware checkpoint. Import does not regenerate glyphs, change refresh policy,
upgrade ESP-IDF, replace the partition or overwrite the existing desktop UI.
`firmware/IMPORT-MANIFEST.json` records the source file hashes and narrowly
adapted entry points. It is a historical import receipt, not a requirement to
freeze all future source edits; current renderer integrity is checked separately.

Source history remains in the retained local firmware repository. Private
history is not attached as a GitHub merge parent; a source checkpoint remains
traceable without publishing old device records or rewriting product history.

## Included and excluded

Included: production drivers/client/rendering, sdkconfig/defaults and lockfile,
optional audio source, font sources/licenses, native/Wasm fixtures and baselines,
regression tests, build/probe/explicit flash scripts, standalone panel experiments,
generic station tool source, and selected technical records with synthetic examples.

Excluded: `.git`, private GitLab CI, build and managed dependency trees, machine
toolchains, personal IDE workspace paths, raw device captures, flash/NVS dumps,
credentials, family-operation instructions, temporary PDF renders and local CAD.
Board schematics, BOM PDFs/spreadsheets, photographs and enclosure files are left
for the hardware contributor's separately reviewed upload under `hardware/`.

Adaptations are limited to in-repository preview-loader paths, toolchain override
handling, portable documentation, ignore rules and the disabled legacy 0.0.9
private-package flash helper. Original font and linked-code notices are preserved.
No `.gitmodules` entry or Git link is used; cloning CodePulse is sufficient.

## Build and review

See [firmware quick start](../firmware/README.md), [firmware development](../firmware/doc/DEVELOPMENT.md)
and [repository ownership](REPOSITORY.md). Desktop still builds with pnpm alone.
Firmware uses ESP-IDF 6.0.1 / esp32s3; lockfile versions stay unchanged.
`node scripts/check-firmware-preview.mjs` checks both preview assets and each
in-tree manifest source without installing the SDK. Configured cJSON may be
checked strictly with `--require-components`.

The independent firmware workflow compiles default and PAIR150/region profiles
plus non-driving audio, checks font/host-tool data, and stores short-lived CI
build artifacts. It never grants flashing, release or product-main permission.
Local migration checks and their exact outcomes are recorded below before publication.

## Physical status

Board1 was app-only updated to **0.0.28-desk-region-pair150** on 2026-10-30.
Chip/partition identity, image write/hash, normal live version, provisioned state,
Wi-Fi and desktop connectivity were observed. NVS and existing partition remained;
audio is off. The observation did not capture clean-baseline completion and does
not establish optical quality. The imported 0.0.29 calendar/native-font source
is a newer candidate; **this migration does not flash it** or claim real hardware,
red pigment, new PCB, microphone or speaker acceptance.

## Checks for this import

Checks run from the new in-repository firmware path:

- Fresh ESP-IDF 6.0.1 default build passes: app `0x157c40`, original application
  partition `0x177000`. The PAIR150/region profile also passes: app `0x157d70`.
  Both leave 8% free; the build cache is restored to default afterward. No SDK,
  partition or runtime source was changed to obtain these results.
- Protocol/calendar parser, driver lifecycle, refresh/pacing/red, pet/calendar
  layout and audio-off/pin-policy host regressions pass. Station tools pass
  30 isolated unit tests; these tests mock flashing and never touch a real device.
- Rebuilt native/Wasm renders match in **122** black/red cases and **800** repeat
  renders. **65** original BW and **11** original red inputs retain both planes
  of the committed 0.0.29 pixel baseline. Rebuilt Wasm SHA256 is exactly the
  already-published preview hash above; neither UI's renderer assets were changed.
- All **55** manifest source hashes match after public locked dependencies are
  configured; the SDK-free mode checks 52 and explicitly defers 3 dependency files.
  Both UI/public notices match. A separate synthetic stale-source test is rejected.
- Stdlib font regeneration/coverage/metrics/notices pass. The calendar charset
  check passes for 106 codepoints, 95 labels, 73,414 civil days and 2,412 months
  using Node 22.15 with explicit `--experimental-strip-types`.
- Imported PowerShell syntax, new workflow YAML/profile permissions, Markdown
  links and the publication allowlist pass. No new secret/private-host finding,
  ignored import file, nested Git metadata or hardware design is included.

No Electron/SQLite dependency was rebuilt, production client restarted, hardware
accessed or firmware flashed in this migration. The isolated UI follow-up is
described below. The
new GitHub firmware workflow is checked as configuration here; its remote run
is a separate result. Full new-board audio compilation/physical sound is not
claimed by the legacy audio-off host checks.

## Remote CI follow-up

The first public firmware workflow passed its source/font/calendar job and all
three ESP-IDF profiles (default, region/PAIR150 and non-driving audio). The
existing desktop workflow also passed types, regression tests and builds on
Windows and Linux. Its Windows surface fixture initially assumed a Chinese OS;
GitHub's English runner failed the explicit Chinese-label assertion. The fixture
now seeds Chinese in its disposable profile before checking Chinese labels. This
does not change production locale behavior, app settings or the imported firmware.

The corrected fixture also passed a local English-locale isolated surface run,
including tasks, images, pets, calendar, HUD coexistence and canonical-state
checks. That local test process alone used a NetworkServiceSandbox workaround
already required on this machine; production settings/outputs were untouched.
GitHub runs the committed harness with its normal flags, independently of this
local workaround. Local type checks passed after the fixture edit.
