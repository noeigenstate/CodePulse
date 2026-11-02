# Cross-surface work voice — implementation handoff

Source: the root Git commit containing this handoff, based on product main, 2026-11-02.
Owner: this user-authorized product/firmware task. No other agent is editing the files.

Requirement: desktop and e-paper independently select work intervention/fault speech.
One host policy observes canonical states; ESP32 only claims, plays PCM16 mono 16kHz
and acknowledges after playback. Use additive authenticated /api/v1/device/work/voice
routes, independent of assistant cloud keys/microphone settings. Legacy audio remains off;
all unverified pins remain -1 and compile-only checks must never drive a board.

400x300 sample: existing 6-task density fixture, identical pixels and refresh behavior.
No renderer/font/status projection/layout/refresh-waveform change is planned.
Firmware files: main/codepulse_audio.c; desktop runtime/HTTP/shared preferences/Control UI.
Acceptance: no historical replay; stale/resolved/disabled alerts cannot be claimed;
bounded device leases/attempts; ACK only after playback; desktop and device switches
independent; old firmware ignores the new routes; no flash, PCB/pins or optical claims.

Software checks: isolated state/HTTP/UI regressions, source/preview hashes, audio pin/no-op
checks and non-driving ESP-IDF compile; completed results are listed below. Hardware speaker,
audio levels and network-loss listening acceptance remain pending until the PCB is verified.

## Check results — 2026-11-02

- 189 focused Node cases passed (including the subsequent passive-browsing fix), with a dependency audit excluding native SQLite,
  Electron and serial bindings. These cover migration, per-output isolation, auth,
  expiry/ACK/retry, repeated manual pauses, old-clip invalidation and shared labels.
- Type checks and a relocated desktop/HUD build passed. Chinese/English host TTS
  produced bounded raw PCM16LE / 16 kHz / mono without speaker playback.
- Focused renderer-only validation uses no database/production backend. It checks
  per-output settings, absence from global Settings, unavailable-device gating,
  English voice copy and the bilingual state guide. See local result receipt.
- Both 400x300 previews and all 55 configured source hashes remain identical.
- Audio GPIO/no-op checks passed. ESP-IDF 6.0.1 SpeakerOnly compile-only target
  built successfully: app 0x15d230 in its separate 0x200000 partition, 32% free.
  CODEPULSE_AUDIO_COMPILE_TEST=ON prevents hardware initialization; do not flash it.
- No production PCB/pin/partition change, optical/audio acceptance or firmware flash
  was performed. The updated client was started separately for user validation; source
  publication is independent of flashing and acoustic acceptance.

The exact 400x300 reference remains the 6-task density fixture in
apps/desktop/src/renderer/src/components/device-density-preview.ts. No rendering
or refresh contract changed. Before main publication, a source export with separately
copied dependencies passed all 792 Node tests, type checks, the desktop/HUD build and
isolated Electron surface checks. Production output/native dependency hashes were
unchanged. Speaker hardware and acoustic validation are still pending.
