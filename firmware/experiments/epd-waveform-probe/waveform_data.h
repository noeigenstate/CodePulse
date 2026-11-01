#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

/* Numeric GDEW042Z15 waveform data published by beee on 2018-03-03:
 * https://forum.arduino.cc/t/waveshare-e-paper-displays-with-spi/467865?page=22
 * This is NOT a vendor-qualified waveform for the prototype glass batch.
 * Four duration fields and a repetition field per six-byte group.
 * In BWR mode 0x21 (old/new WW) is unused; load VCOM, R, W, B only.
 */
static const uint8_t probe_group_timing[7][5] = {
    {26, 26, 0, 0, 1}, {10, 10, 0, 0, 8},
    {14, 1, 14, 1, 16}, {10, 10, 0, 0, 8},
    {4, 16, 0, 0, 5}, {3, 14, 0, 0, 10}, {35, 0, 0, 0, 1},
};
static const uint8_t probe_group_levels[4][7] = {
    {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
    {0xA0, 0x00, 0x84, 0x90, 0xB0, 0xB0, 0xC0},
    {0x90, 0x40, 0x84, 0x80, 0x00, 0x00, 0x00},
    {0x90, 0x20, 0x84, 0x10, 0x00, 0x00, 0x00},
};
static const uint8_t probe_lut_commands[4] = {0x20, 0x22, 0x23, 0x24};

static size_t probe_make_lut(unsigned table, unsigned profile, uint8_t out[44]) {
  if (table >= 4 || (profile < 1 || profile > 3) || out == NULL) return 0;
  memset(out, 0, 44);
  if (profile == 3) return table == 0 ? 44 : 42; /* zero-drive diagnostic */
  for (unsigned group = 0; group < 7; ++group) {
    out[group * 6] = probe_group_levels[table][group];
    memcpy(out + group * 6 + 1, probe_group_timing[group], 5);
    /* Preserve the entire polarity/duration group; reduce only repetitions. */
    if (profile == 2 && (group == 1 || group == 2 || group == 3))
      out[group * 6 + 5] /= 2;
  }
  return table == 0 ? 44 : 42;
}
