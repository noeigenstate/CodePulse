# Host synchronization regression

After the first ESP-IDF build has downloaded the locked cJSON component, run
`scripts/test-host.ps1` on Windows with MSVC C tools installed. This compiles the
actual `main/codepulse_protocol.c` and `main/display_sync_policy.c`, plus the
locked cJSON source. SDK/GPIO stubs only provide types/constants; no hardware is
accessed. Build output is ignored under `build-host-tests/`.

Checks cover account-only versus live idle tasks, quota retention, Codex running
and waiting states, invalid-response preservation, small-sensor suppression,
cumulative sensor/battery thresholds, independent agent-state debounce,
visible-only quota changes, connectivity debounce, cooldown boundaries,
failed-frame recovery, provider ordering and successful manual baselines.
They do not prove a physical panel waveform, Wi-Fi polling, power behavior or
successful flash. Use `scripts/build.ps1` and then board acceptance separately.
