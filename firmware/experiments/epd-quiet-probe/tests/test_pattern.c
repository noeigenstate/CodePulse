#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "quiet_pattern.h"

static uint8_t pixels[3][EPD_CANVAS_BUFFER_SIZE], red_plane[EPD_CANVAS_BUFFER_SIZE];
static bool ink(unsigned phase, int x, int y) {
  return !(pixels[phase][y * 50 + x / 8] & (0x80u >> (x % 8)));
}
int main(void) {
  for (unsigned phase = 0; phase < 3; ++phase) {
    epd_canvas_t canvas = {.black = pixels[phase], .red = red_plane};
    quiet_draw_pattern(&canvas, (epd_quiet_phase_t)phase);
    for (size_t i = 0; i < sizeof(red_plane); ++i) assert(red_plane[i] == 0xFF);
    for (unsigned row = 0; row < 2; ++row) {
      const int top = row == 0 ? 96 : 184;
      const bool updated = row == 0 ? phase >= 1 : phase == 2;
      for (int y = top; y < top + 40; ++y) {
        for (int x = 0; x < 400; ++x) {
          bool expected = false;
          for (int col = 0; col < 4; ++col)
            if (x >= 16 + col * 96 && x < 80 + col * 96 && y >= top + 8 && y < top + 32)
              expected = (updated ? col == 1 : col == 2) || col == 3;
          assert(ink(phase, x, y) == expected);
        }
      }
    }
  }
  /* One baseline suffices only if phase A never changes B, and vice versa. */
  for (int y = 0; y < 300; ++y) {
    if (y < 96 || y >= 136) assert(!memcmp(pixels[0] + y * 50, pixels[1] + y * 50, 50));
    if (y < 184 || y >= 224) assert(!memcmp(pixels[1] + y * 50, pixels[2] + y * 50, 50));
  }
  for (unsigned phase = 0; phase < 3; ++phase) {
    char filename[32];
    (void)snprintf(filename, sizeof(filename), "quiet2-stage-%u.pgm", phase);
    FILE *f = NULL;
    assert(fopen_s(&f, filename, "wb") == 0 && f);
    fprintf(f, "P5\n400 300\n255\n");
    for (int y = 0; y < 300; ++y)
      for (int x = 0; x < 400; ++x) fputc(ink(phase, x, y) ? 0 : 255, f);
    assert(fclose(f) == 0);
  }
  puts("PASS: actual renderer WW/WB/BW/BB cells, blank red plane, independent rows and static controls");
}
