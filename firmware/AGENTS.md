# Firmware inside the CodePulse repository

Read ../AGENTS.md, ../docs/REPOSITORY.md, README.md and doc/DEVELOPMENT.md.

- This directory is part of the root Git repository. Commit and push from that
  repository; there is no firmware origin/main or second publishing remote.
  The root product main is the development/publication target. Publish only with
  task authorization. A code push does not authorize a release or hardware flash.
- Preserve ESP-IDF v6.0.1, esp32s3 and dependencies.lock. Keep generated builds,
  managed_components, toolchains, credentials, NVS and captures out of Git.
- Assert GPIO9 PWR_HOLD before board initialization. Preserve the existing
  function/power button, no automatic post-flash reset, bounded BUSY waits and
  safe panel shutdown. Fresh physical power-hold confirmation is required to flash.
- Board1 uses the legacy 400x300 WFT0420CZ15 and GPIO42-to-GPIO8 battery flywire;
  both battery pads remain inputs. See doc/BOARD1.md before changing GPIOs.
- Audio is off on Board1. The new PCB is unverified and the old LumaDesk audio
  pins overlap EPD. Use scripts/build-audio-check.ps1 only for non-driving checks.
- ../docs/device-api-v1.md defines the host contract; doc/APP_DEVICE_PROVISIONING_V1.md
  defines USB CP1. Keep unknown/optional fields compatible. Share task semantics
  with desktop/HUD; firmware owns rendering and physical refresh rules.
- Renderer/font changes require both desktop preview directories and public
  font notices to be regenerated together with ../scripts/sync-device-preview.ps1.
  Agree on one owner for generated files; do not overwrite another agent's work.
- Firmware runtime version stays in CMakeLists.txt; it is independent of the
  desktop package version. Record root commit, firmware version, board revision,
  partition and image hash. Separate host checks, flashing, boot and optical proof.
- Hardware design sources belong in ../hardware under their contributor's
  reviewed board/revision and license. Do not import old local CAD or PDFs by default.
