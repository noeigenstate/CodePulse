#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "resolution_pattern.h"

static uint8_t black[15002], red[15002];
static bool black_at(int x, int y) {
  const unsigned index = (unsigned)y * 50 + (unsigned)x / 8;
  return (black[index + 1] & (0x80u >> (x % 8))) == 0;
}
int main(int argc, char **argv) {
  assert(argc == 2);
  memset(black, 0xa5, sizeof(black));
  memset(red, 0x5a, sizeof(red));
  epd_canvas_t canvas = {.black = black + 1, .red = red + 1};
  codepulse_resolution_pattern(&canvas);
  assert(black[0] == 0xa5 && black[15001] == 0xa5);
  assert(red[0] == 0x5a && red[15001] == 0x5a);
  for (int i = 1; i <= 15000; ++i) {
    assert(red[i] == 0xff);
  }
  for (int x = 0; x < 400; ++x) {
    assert(black_at(x, 0) && black_at(x, 299));
  }
  for (int y = 0; y < 300; ++y) {
    assert(black_at(0, y) && black_at(399, y));
  }
  /* Byte-aligned native patches: known wire bytes, independently read MSB-first. */
  const uint8_t expected[] = {0x55, 0x33, 0x0f};
  for (int row = 0; row < 3; ++row) {
    const int y = 48 + row * 80, pitch = 1 << row;
    for (int b = 0; b < 14; ++b) {
      assert(black[1 + y * 50 + 2 + b] == expected[row]);
      assert(black[1 + (y + 47) * 50 + 2 + b] == expected[row]);
      assert(black[1 + y * 50 + 18 + b] == 0x00);
      assert(black[1 + (y + pitch) * 50 + 18 + b] == 0xff);
      assert(black[1 + y * 50 + 34 + b] == expected[row]);
      assert(black[1 + (y + pitch) * 50 + 34 + b] == (uint8_t)~expected[row]);
    }
  }
  FILE *f = fopen(argv[1], "wb");
  assert(f != NULL);
  fprintf(f, "P5\n400 300\n255\n");
  for (int y = 0; y < 300; ++y) {
    for (int x = 0; x < 400; ++x) {
      fputc(black_at(x, y) ? 0 : 255, f);
    }
  }
  assert(fclose(f) == 0);
  puts("PASS: exact native wire bytes, 1/2/4-pixel patches, full borders, white red plane and buffer guards");
  return 0;
}
