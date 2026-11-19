#pragma once
#include "../epd-waveform-probe/waveform_data.h"

/* Numeric reference, not private panel OTP. Always write all five sequencer
 * slots, including WW at 0x21 (unlike the legacy header's comment).
 *
 * .40: one repeat in groups 1/2/3, 427 nominal frames. Flicker accepted once,
 * but red erasure and black contrast failed. It remains available explicitly.
 *
 * .41 HOLD: keep the complete .39 SHORT per-level frame budget, but coalesce
 * repeated phases into single longer holds:
 *   group 1: (10,10,0,0) x 4 -> (40,40,0,0) x 1
 *   group 2: (14,1,14,1) x 8 -> (112,8,112,8) x 1
 *   group 3: (10,10,0,0) x 4 -> (40,40,0,0) x 1
 * 757 nominal frames; one common bipolar cycle, not eight. Level codes,
 * initial conditioning, red settling, clock and voltages are unchanged.
 * Equal cumulative frame budgets do NOT imply equal pigment response or
 * qualify this panel for long-term use. Hardware optical verdict required.
 */
static size_t red_badge_make_lut(unsigned slot, uint8_t out[44]) {
  static const unsigned reference[5] = {0, 2, 1, 2, 3};
  if (slot >= 5 || !out) return 0;
#if defined(CODEPULSE_EPD_RED_BADGE_HOLD) && CODEPULSE_EPD_RED_BADGE_HOLD
  const size_t length = probe_make_lut(reference[slot], 2, out);
  for (unsigned group=1; group<=3; ++group) {
    const unsigned offset=group*6u, repetitions=out[offset+5u];
    for (unsigned phase=1; phase<=4; ++phase) {
      const unsigned duration=(unsigned)out[offset+phase]*repetitions;
      if (duration>UINT8_MAX) { memset(out,0,44); return 0; }
      out[offset+phase]=(uint8_t)duration;
    }
    out[offset+5u]=1;
  }
#else
  const size_t length = probe_make_lut(reference[slot], 1, out);
  out[11] = out[17] = out[23] = 1;
#endif
  return length;
}
