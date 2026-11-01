#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "quiet_probe.h"

/* Numerical reference: Jean-Marc Zingg, GxEPD2_420.cpp, commit
 * de82887e77a78528ea386e68bba2cb0291d2c319, partial waveform T1/T2/T3/T4.
 * https://github.com/ZinggJM/GxEPD2/blob/de82887e77a78528ea386e68bba2cb0291d2c319/src/epd/GxEPD2_420.cpp
 * Published for BW GDEW042T2/IL0398. NOT qualified for this BWR glass.
 * REFERENCE preserves timing. LONG_PAIR is a local, unqualified experiment:
 * double T1/T4 together (25->50); keep levels, T2/T3 and repeats unchanged.
 * This preserves the equal-duration opposed pair, not a claim of measured
 * charge balance on this glass. Do not copy voltage/PLL settings.
 */
static size_t quiet_make_lut(epd_quiet_phase_t phase, unsigned table, uint8_t out[44]) {
  static const uint8_t levels[5] = {0x00, 0x18, 0x5A, 0xA5, 0x24};
  if (table >= 5 || out == NULL ||
      (phase != QUIET_REFERENCE && phase != QUIET_LONG_PAIR)) return 0;
  memset(out, 0, 44);
  out[0] = levels[table];
  out[1] = phase == QUIET_LONG_PAIR ? 50 : 25;
  out[2] = 1; out[3] = 4; out[4] = out[1]; out[5] = 1;
  out[7] = 1; out[11] = 1; /* one final ground frame, no repeated loops */
  return table == 0 ? 44 : 42;
}
