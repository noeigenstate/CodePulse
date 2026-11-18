# Board1 panel status / OTP readback

Default-off CODEPULSE_EPD_PANEL_READBACK=ON, version 0.0.38-panel-readback.
This diagnostic investigates why the 0.0.37 FULL/SHORT register waveforms both
took 15237 ms. It is not a red-refresh fix and performs no optical experiment.

Run before production SPI initialization, after power-hold, safe GPIO, USB and
button services. Exclusively use existing EPD GPIO4/5/6/7/16/17. Read through
bidirectional GPIO17/SDA at about 25 kHz; no extra MISO connection or BS change.
The read route on this physical PCB remains unverified until the status challenge
passes. A failed read is not evidence that the panel's OTP is empty.

Only 0x70 (OTP revision), 0x71 (status), 0xA2 (read OTP), 0x91/0x92 (logic-mode
challenge) are permitted. Hardware reset occurs with the booster off. Never send
POWER_ON, DISPLAY_REFRESH, voltage/LUT writes, VCOM measurement, OTP program-mode
0xA0 or program 0xA1. No normal-app fallback or automatic refresh. Short press
only repeats the saved report; long press uses normal shutdown. Reboot stays in
the diagnostic; restoring normal use requires the separately verified app image.

Verify PTL_FLAG changes 0 -> 1 -> 0 while BUSY_N=1 and PON=0, then read R70
and two identical nonuniform 4096-byte OTP dumps (one dummy byte each).
Crosscheck OTP[1] against R70. R70 is a waveform revision, **not a silicon ID**.
OTP[0x20]==0xA5 enables factory defaults; [0x21]/[0x27] describe PSR/CDI defaults.
The documented interface does not expose current PSR/PLL/CDI or volatile LUT
readback. OTP data cannot prove the .37 register tables were executed.

Sources: [UC8176 manual](https://files.waveshare.com/upload/8/88/UC8176.pdf),
pp. 6, 23, 26–30, 34–35. Driver/code checks, read-link verification, raw factory
evidence and optical results are separate. Captures remain in ignored local
.tmpshots/panel-readback-20261105; do not publish a panel OTP dump by default.

No desktop API, renderer, font, production waveform, NVS or pin/power-contract
changes. The 400×300 image is left physically unchanged. No flash is implied by
a successful host test or build; each flash needs fresh physical power-hold.
