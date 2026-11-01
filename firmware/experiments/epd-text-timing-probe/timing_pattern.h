#pragma once
#include "timing_probe.h"

/* Same accepted A position, font and glyphs; B is a static OTP control. */
static void timing_probe_pattern(epd_canvas_t *canvas, bool active) {
  epd_canvas_clear(canvas, EPD_COLOR_WHITE);
  epd_canvas_draw_text(canvas, 12, 12, "TEXT CYCLE", 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 50, "REF WAIT 01% / RUN 12%", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 76, "A - PAIR 125", 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 0, 93, 400, 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 106, active ? "CODEX RUN 12%" : "CODEX WAIT 01%", 3, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 0, 138, 400, 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 162, "STATIC REFERENCE", 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 0, 181, 400, 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 194, "CODEX WAIT 01%", 3, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 0, 226, 400, 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 250, "FOUR MANUAL UPDATES", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 274, "TEST DATA - STATIC CONTROL", 2, EPD_COLOR_BLACK);
}
