# Dynamic red badge candidate

Default-off CODEPULSE_EPD_RED_BADGE_PROBE, version 0.0.40-red-badge.
See [design and validation](../../doc/RED-BADGE-LAB-2026-11-06.md).

Uses all five register waveform slots with common conditioning repeats 1/1/1,
unchanged red-specific settling, and an 80×28 partial window. Both test steps
change red: erase the old badge, then draw a new red badge. Same-row black/red
controls expose horizontal spill outside the requested window.

This is not production or a qualified panel waveform. The 427-frame budget and
host SPI checks do not establish optical behavior or acceptable flicker.
Run test.ps1 for Debug/NDEBUG driver, containment, failure and lifecycle checks.

Build only with existing Board1 PAIR150/RECT flags and this probe, all other
probes/audio disabled. Explicit fresh power hold is required before application-
only flashing. No NVS/OTP changes, no automatic repeated refreshes, no voltage
changes. Manual cooldown and safe shutdown remain enforced.

## Long-hold variant

CODEPULSE_EPD_RED_BADGE_HOLD=ON additionally selects 0.0.41-red-hold;
it requires the badge diagnostic and never enables itself in production.
The original .40 option remains available but failed red-erasure/black-contrast
acceptance despite the user's acceptable-flicker report.

The HOLD variant restores .39 SHORT's cumulative level durations while
coalescing the 4/8/4 repetitions into three single-cycle groups. All five
slots have 757 nominal frames. Red settling and voltage settings stay unchanged.
Equal dwell budgets are not proof of equal pigment response.
Run test.ps1 -Hold as well as the default checks.
See [HOLD details and acceptance](../../doc/RED-HOLD-LAB-2026-11-06.md).
