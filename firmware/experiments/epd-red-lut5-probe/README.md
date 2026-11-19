# Complete five-table red waveform candidate

Default-off CODEPULSE_EPD_RED_LUT5_PROBE=ON, version 0.0.39-red-lut5.
This follows the successful 0.0.38 physical OTP readback. The prior red experiment
loaded 0x20/22/23/24 and inherited 0x21; the working BW path writes 0x20..24.
The physical OTP has five same-timing table-shaped blocks per temperature bank.
This candidate closes that gap; missing 0x21 is **not yet proven** to explain the
unchanged 15.237-second timing.

It retains the .37 sequence, voltage calibration and four reference curves.
The only extra waveform write is 42 bytes at 0x21, using the original reference
WW curve (same values as W). All five slots use matching timing. It does not
write the captured factory OTP into source, reprogram OTP, change voltage or
raise the clock above the already-tested 100Hz. No production changes.

The optical pattern now tests the previously failing case explicitly:
- Baseline: left red WAIT, right black READY.
- First manual step: FULL, both black READY; no red anywhere inside the band.
- Second manual step: SHORT, red ERROR appears on the right.
Static red and black above/below are identical in every 400×300 frame.
Wait at least 180 seconds after each completed refresh. Short is manual only;
long powers off. No shortened step if FULL still takes 14.5 seconds or longer:
the firmware holds and permits only shutdown, avoiding another ineffective test.
A software or optical failure is not authorization to continue another exposure.

Tests execute the real driver with every SPI transfer and table checked, complete
red-plane absence in the first target band, reappearance in the second, unchanged
outside RAM, bad BUSY/power cases and 1087 transfer failure points per configuration.
Debug/NDEBUG also test the timing gate, long-press priority and native frame parity.
The timing model is not evidence of real controller timing or optical quality.

See [lab record](../../doc/RED-LUT5-LAB-2026-11-05.md).
Previous .37 source/ELF/bin evidence was frozen by source hash before reusing its
compile cache to reduce CPU load. Builds use at most two jobs. No desktop protocol,
preview/font, NVS or pin changes. Flash requires a fresh physical power-hold.
