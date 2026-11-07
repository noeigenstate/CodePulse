# Native 400x300 pixel diagnostic

Requirement / handoff: verify Board1 addressing and optical resolution with native
1/2/4-pixel vertical, horizontal and checker patches, edge borders and 10-pixel ticks.
Baseline: d1f803d, firmware source bd3fbd8 / 0.0.30-life-region-pair150.
Owner: user-authorized resolution diagnostic, 2026-11-03. Do not modify weather or
desktop content work. Integration files: root firmware CMakeLists.txt,
main/CMakeLists.txt and app_main.c; new code stays in this experiment directory.

Build with CODEPULSE_EPD_RESOLUTION_PROBE=ON. Default builds are unchanged.
Runtime identity is 0.0.30-resolution-probe. Keep the existing Board1 pins,
PAIR150/region configuration, ESP-IDF 6.0.1 and unchanged factory/NVS partitions.
No new protocol, font assets, panel waveform, voltage, PLL, OTP or display geometry.

400x300 reference: test code emits reference.pgm from the same C draw routine.
Each plane is exactly 15000 bytes, MSB first, 50 bytes per row. Black is active-low;
the red plane stays 0xff. Patch size is 112x48 at x=16/144/272 and y=48/128/208.
Columns are vertical/horizontal/checker; rows have black/white cell sizes 1/2/4.
The outer border includes x=0/399 and y=0/299, with a second border two pixels in.
No image decoder, scaling, dithering, desktop UI or typography renderer is involved.

Expected refresh: one existing OTP full refresh on boot, then normal HV-off hold.
No periodic screen refresh or network polling while the diagnostic is displayed.
Short press after completion resumes the normal application, using the existing
button monitor; presses during the waveform are discarded. Long hold shuts down
through the normal safe path. An error stops without a retry. NVS is not modified.

Validation: run test.ps1 for encoded plane/border/pattern checks and the reference;
build the ESP32-S3 target separately. Source/build pass is not optical acceptance.
Check an actual close-up for separate one-pixel strokes in BOTH axes, complete
borders and no duplicated/skipped lines. A blurred 1px checker alone can be camera
moire; inspect stripes with a magnifier. Measured distinguishable pitch and native
addressability are separate conclusions. A photo is required for visual analysis.

The ordinary production renderer, fonts and paired desktop previews are unchanged.
Do not publish or flash automatically. Preserve the verified normal image so the
original firmware can be restored after testing if desired.

## Prepared validation result (2026-11-03; not flashed yet)

Native pattern checks passed: packed bytes at all pitches, complete outer border,
empty red plane, and buffer guards. Control checks passed: exactly one refresh,
short return, long shutdown request, input discard during refresh, no error retries.
ESP-IDF 6.0.1 build passed: 1,439,184-byte application in the unchanged 1,536,000-byte
factory partition (96,816 bytes free). Image SHA256:
`495deed7c656a9726a207e4a8487b5dfd6b46a17b636fcabfbcbe3265de69458`.
Both production previews and all 63 source/dependency hashes remain valid.
Original 0.0.30-life-region-pair150 rollback binary is preserved byte-for-byte.
Physical display, one-pixel contrast and edge visibility still need testing.

Build from the root (existing ESP-IDF environment):

```powershell
idf.py -C firmware -B firmware/build-resolution-probe -D CODEPULSE_EPD_RESOLUTION_PROBE=ON -D CODEPULSE_QUIET_RECT_TRIAL=ON -D CODEPULSE_QUIET_PAIR150_TRIAL=ON build
powershell -File firmware/experiments/epd-resolution-probe/test.ps1 -Output .tmpshots/resolution-probe/host
```

This diagnostic appears at every boot of this opt-in image. A fresh short press
after the image settles resumes the normal app and Wi-Fi; no NVS setting is changed.
The production image remains available if the diagnostic firmware is to be removed.
