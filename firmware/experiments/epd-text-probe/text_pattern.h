#pragma once
#include "quiet_probe.h"

/* Test data only: fixed OTP reference samples outside the successful B window. */
static void text_probe_pattern(epd_canvas_t *canvas, bool active) {
  epd_canvas_clear(canvas, EPD_COLOR_WHITE);
  epd_canvas_draw_text(canvas, 12, 12, "CODEPULSE TEXT", 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 48, "TEST DATA - STATIC REFERENCES", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 82, "WAIT 01%", 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 124, "RUN 12%", 3, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 0, 181, 400, 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 194, active ? "CODEX RUN 12%" : "CODEX WAIT 01%", 3, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 0, 226, 400, 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 250, "FOUR MANUAL UPDATES", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 274, "KEEP REFERENCES STABLE", 2, EPD_COLOR_BLACK);
}
