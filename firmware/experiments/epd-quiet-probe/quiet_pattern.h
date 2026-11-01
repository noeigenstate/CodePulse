#pragma once
#include "quiet_probe.h"

/* All labels and outlines are outside the two 400x40 drive windows. */
static void quiet_draw_pattern(epd_canvas_t *canvas, epd_quiet_phase_t phase) {
  static const char *labels[4] = {"1 WW", "2 WB", "3 BW", "4 BB"};
  epd_canvas_clear(canvas, EPD_COLOR_WHITE);
  epd_canvas_draw_text(canvas, 12, 12, "QUIET 2", 3, EPD_COLOR_BLACK);
  for (unsigned row = 0; row < 2; ++row) {
    const int y = row == 0 ? (int)QUIET_ROW_A : (int)QUIET_ROW_B;
    const bool updated = row == 0 ? phase >= QUIET_REFERENCE : phase == QUIET_LONG_PAIR;
    epd_canvas_draw_text(canvas, 12, y - 40, row == 0 ? "A REF" : "B LONG", 2, EPD_COLOR_BLACK);
    for (unsigned col = 0; col < 4; ++col) {
      const int x = 16 + (int)col * 96;
      epd_canvas_draw_text(canvas, x, y - 18, labels[col], 2, EPD_COLOR_BLACK);
      /* Black only at 3+4 before; 2+4 after. Cell 1 stays white, 4 black. */
      if ((updated ? col == 1 : col == 2) || col == 3)
        epd_canvas_fill_rect(canvas, x, y + 8, 64, 24, EPD_COLOR_BLACK);
    }
    epd_canvas_fill_rect(canvas, 0, y - 3, 400, 1, EPD_COLOR_BLACK);
    epd_canvas_fill_rect(canvas, 0, y + (int)QUIET_WINDOW_HEIGHT + 2, 400, 1, EPD_COLOR_BLACK);
  }
  epd_canvas_draw_text(canvas, 12, 246, "BASE BLACK 3+4", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 270, "NEXT BLACK 2+4", 2, EPD_COLOR_BLACK);
}
