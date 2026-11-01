#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "quiet_profile.h"
/* PAIR125 accepted on Board1: four manual updates at 2.633 s each.
 * These are the exact 0.0.8 PAIR125 bytes, not a new waveform.
 * Numerical reference: GxEPD2_420.cpp, de82887e77a78528ea386e68bba2cb0291d2c319.
 * https://github.com/ZinggJM/GxEPD2/blob/de82887e77a78528ea386e68bba2cb0291d2c319/src/epd/GxEPD2_420.cpp
 * Default preserves PAIR125 exactly. The opt-in PAIR150 trial changes only
 * T1/T4 together, matching the archived, previously untested PAIR150 table.
 * Level codes, T2/T3, repeat=1 and ground frame stay identical. Not optically
 * qualified; expected ~3.13 s at the existing explicit 100 Hz.
 * This table does not program voltage, PLL or OTP.
 */
static size_t quiet_make_lut(unsigned table, uint8_t out[44]) {
  static const uint8_t levels[5] = {0x00, 0x18, 0x5A, 0xA5, 0x24};
  if (table >= 5 || !out) return 0;
  memset(out, 0, 44);
  out[0] = levels[table];
  out[1] = EPD_QUIET_PAIR_FRAMES; out[2] = 1; out[3] = 4; out[4] = EPD_QUIET_PAIR_FRAMES; out[5] = 1;
  out[7] = 1; out[11] = 1;
  return table == 0 ? 44 : 42;
}
