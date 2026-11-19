# Transition-mask red experiment

Default-off CODEPULSE_EPD_RED_MASK_PROBE, 0.0.42-red-mask.
See [design, limits and validation](../../doc/RED-MASK-LAB-2026-11-06.md).

Compares old/new canonical pixels and uploads temporary BWR selector masks:
unchanged -> HOLD, changed white -> white pulse, changed black/red -> selected
paint pulse. Rejects updates requiring both newly driven black and red before
touching hardware. Writes all five LUT slots and restores canonical image RAM
after HV shutdown, without another refresh.

Direct single-direction pulses remove the common inversion sequence. They are
NOT charge-balanced/production-qualified or a promise of clean red removal.
Manual two-step experiment only, 180-second intervals, no automated retries.
Fresh physical power hold is required to flash. No pin, voltage, VCOM_DC, OTP,
NVS, font, desktop preview or default production behavior changes.

Run test.ps1 for Debug/NDEBUG real-driver pixel routing, power/RAM lifecycle,
fault-injection and manual-control checks. Hardware optics remain unverified.

## Clear-then-black variant

Additional default-off CODEPULSE_EPD_RED_MASK_BLACK selects 0.0.43-red-black.
See [evidence, two-pass design and limits](../../doc/RED-BLACK-LAB-2026-11-06.md).
The first manual operation clears changed pixels using the tested .42 white path,
then drives only new black letters through R24. Either pass failing invalidates
the session and prevents further driving. No voltage/clock changes or retries.
Run test.ps1 -BlackStage for this variant; omit it to regress original .42.

## Measured red-pulse variant

Additional default-off CODEPULSE_EPD_RED_MASK_COLOR requires the black-stage
variant and selects 0.0.44-red-color. See [evidence and limits](../../doc/RED-COLOR-LAB-2026-11-06.md).
Starts at white/black READY, so the single manual test checks red ERROR appearance.
Clears changed pixels, then selects only new red pixels with the R22/40/178
combination that produced actual new red glyphs in .42. Keeps .43's accepted
erase/black path unchanged. No claim of pigment correctness before the new test.
Run test.ps1 -ColorStage; -BlackStage and no switch retain prior regressions.


## .45: retain the segmented red tail, do not merge its pulses

Additional default-off `CODEPULSE_EPD_RED_MASK_PULSE=ON` requires COLOR/BLACK/MASK.
Version `0.0.45-red-pulse` starts from READY and requests one manual red appearance.
.44 was optically rejected (black instead of red), despite both hardware phases
completing normally. Keep that implementation as an explicit diagnostic control.

After the unchanged 179-frame clear, only the 1888 new red pixels receive exact
groups 4..6 of the .39 table: B0 (4,16)x5; B0 (3,14)x10; C0 35 frames. Add one neutral
frame. The red tail is 306 frames, total 485 frames; these are configuration counts,
not an optical guarantee or a hardware measurement. Other pixels stay HOLD.
The .39 complete waveform produced red; extracting its tail still needs validation.
No common whole-window inversions, voltage writes, frequency changes or retries.
Clear gate remains 3500ms; red tail gate 4200ms; total drive gate 6500ms.
Run `test.ps1 -PulseStage`; .44/.43 controls remain available via ColorStage/BlackStage.
See [experiment and evidence](../../doc/RED-PULSE-LAB-2026-11-06.md).


## .46: retain every red phase, clean white glyphs last

`CODEPULSE_EPD_RED_MASK_ACTIVATE=ON` additionally requires PULSE/COLOR/BLACK/MASK.
Version `0.0.46-red-activate`, default off. .45 failed optically: mixed dark/red,
weak ERROR text and increased flicker. Nothing from .45 qualifies production.

First, only 1888 changed red pixels receive all seven reference phases, with
groups 1/2/3 reduced to one repetition (427 frames). Second, all 352 target WHITE
pixels in the 80x28 badge receive the bounded 179-frame white clear. This includes
96 unchanged white glyph pixels intentionally; other unchanged pixels stay HOLD.
No full-screen white cleanup and no changes to the accepted .43 erase/black path.
The full-reference phase ORDER is retained; reduced repetitions are unqualified.
Nominal total 606 frames; real optics, timing and flicker must be measured.
First/second drive gates 5200/3500ms; overall drive gate 7500ms. No automatic retry.
Run `test.ps1 -ActivateStage`. See [record](../../doc/RED-ACTIVATE-LAB-2026-11-06.md).


## .47: subdivide the accepted color waveform's slow red pulses

`CODEPULSE_EPD_RED_MASK_FAST=ON` additionally requires ACTIVATE. Version .47-red-fast.
.46 colors/text/outside stability passed once; severe flicker failed. Preserve that
exact binary/source as the optical color baseline. This candidate is still unqualified.

Use the UC8176-documented 200Hz frame clock (R30=39) ONLY for the red phase, then
restore 100Hz (3A) before the unchanged white-glyph phase. Keep the prefix's entire
nominal time sequence: merge adjacent neutral timing into group 0 and double counts.
Subdivide the 40/160ms and 30/140ms red-tail pulses into 5/20ms and 5/25ms pulses.
Tail negative time stays 500ms, red time 2550ms, including the final 350ms red hold.
Keep all source/gate/VCOM voltage settings untouched. Equal duration is NOT optical
equivalence, and chip support for 200Hz does not qualify this particular panel batch.

Two phases: 854 frames at 200Hz + 179 at 100Hz = nominal 6060ms (not a speed claim).
Masks, 80x28 scope, gates and manual steps remain .46. Log per-phase Hz and frames;
do not infer milliseconds from the sum of frames with mixed clocks.
Run `test.ps1 -FastStage`, retain ActivateStage/BlackStage regressions.
See [lab record](../../doc/RED-FAST-LAB-2026-11-06.md).
