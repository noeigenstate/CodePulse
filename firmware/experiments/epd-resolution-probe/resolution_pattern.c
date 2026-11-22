#include "resolution_pattern.h"
#include <stdio.h>

_Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300,
               "This diagnostic is specific to the confirmed 400x300 panel");
_Static_assert(EPD_CANVAS_BUFFER_SIZE == 15000, "Unexpected packed plane size");

static void frame(epd_canvas_t *c, int inset) {
  const int w = BOARD_EPD_WIDTH - 2 * inset;
  const int h = BOARD_EPD_HEIGHT - 2 * inset;
  epd_canvas_fill_rect(c, inset, inset, w, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, inset, inset + h - 1, w, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, inset, inset, 1, h, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, inset + w - 1, inset, 1, h, EPD_COLOR_BLACK);
}

void codepulse_resolution_pattern(epd_canvas_t *c) {
  epd_canvas_clear(c, EPD_COLOR_WHITE);
  frame(c, 0);
  frame(c, 2);
  epd_canvas_draw_text(c, 98, 8, "400X300 PIXEL TEST", 2, EPD_COLOR_BLACK);
  for (int x = 10; x < 400; x += 10) {
    const int length = x % 50 == 0 ? 7 : 3;
    epd_canvas_fill_rect(c, x, 25, 1, length, EPD_COLOR_BLACK);
  }
  for (int y = 10; y < 300; y += 10) {
    const int length = y % 50 == 0 ? 7 : 3;
    epd_canvas_fill_rect(c, 4, y, length, 1, EPD_COLOR_BLACK);
    epd_canvas_fill_rect(c, 396 - length, y, length, 1, EPD_COLOR_BLACK);
  }
  const char *names[] = {"VERTICAL", "HORIZONTAL", "CHECKER"};
  for (int row = 0; row < 3; ++row) {
    const int pitch = 1 << row;
    const int y0 = 48 + row * 80;
    for (int col = 0; col < 3; ++col) {
      const int x0 = 16 + col * 128;
      char label[24];
      snprintf(label, sizeof(label), "%s %dPX", names[col], pitch);
      epd_canvas_draw_text(c, x0, y0 - 12, label, 1, EPD_COLOR_BLACK);
      for (int y = 0; y < 48; ++y) {
        for (int x = 0; x < 112; ++x) {
          const int bit = col == 0 ? x / pitch : col == 1 ? y / pitch :
                          (x / pitch + y / pitch);
          if ((bit & 1) == 0) {
            epd_canvas_pixel(c, x0 + x, y0 + y, EPD_COLOR_BLACK);
          }
        }
      }
    }
  }
  epd_canvas_draw_text(c, 18, 270, "NATIVE PIXELS - NO SCALING", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 18, 282, "SHORT PRESS: RETURN TO CODEPULSE", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 342, 286, "399 299", 1, EPD_COLOR_BLACK);
}
