#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "timing_probe.h"

/* Follow-up to measured pair75 (1.613 s) and pair100 (2.133 s):
 * both comfortable; pair100 leaves a fainter text trace. This is not zero ghosting. Same levels, T2/T3, ground frame and repeat=1. Only T1/T4
 * are extended together to 125 or 150. This is a local unqualified BWR trial,
 * not measured charge balance or a manufacturer-approved waveform.
 * Numerical starting point: GxEPD2_420.cpp, commit
 * de82887e77a78528ea386e68bba2cb0291d2c319 (BW GDEW042T2/IL0398).
 * https://github.com/ZinggJM/GxEPD2/blob/de82887e77a78528ea386e68bba2cb0291d2c319/src/epd/GxEPD2_420.cpp
 * No voltage, PLL, OTP programming or extra repeated loops.
 */
static size_t timing_make_lut(epd_timing_phase_t phase, unsigned table, uint8_t out[44]) {
  static const uint8_t levels[5] = {0x00, 0x18, 0x5A, 0xA5, 0x24};
  if (table >= 5 || out == NULL ||
      (phase != TIMING_PAIR125 && phase != TIMING_PAIR150)) return 0;
  memset(out, 0, 44);
  out[0] = levels[table];
  out[1] = phase == TIMING_PAIR150 ? 150 : 125;
  out[2] = 1; out[3] = 4; out[4] = out[1]; out[5] = 1;
  out[7] = 1; out[11] = 1;
  return table == 0 ? 44 : 42;
}
