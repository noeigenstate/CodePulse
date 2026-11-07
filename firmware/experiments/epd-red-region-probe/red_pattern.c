#include "red_probe.h"
#include <string.h>

bool red_probe_draw(epd_canvas_t *c, unsigned frame) {
  if (!c || !c->black || !c->red || frame > RED_PROBE_LAST_FRAME) return false;
  epd_canvas_clear(c, EPD_COLOR_WHITE);
#if defined(CODEPULSE_EPD_RED_BW_ONLY) && CODEPULSE_EPD_RED_BW_ONLY
  epd_canvas_draw_text(c, 12, 12, "STATIC RED BW LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  epd_canvas_draw_text(c, 12, 12, "RED CHANGE LAB", 3, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 12, "RED REGION LAB", 3, EPD_COLOR_BLACK);
#endif
  epd_canvas_draw_text(c, 12, 48, "TOP RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(c, 368, 44, 20, 28, EPD_COLOR_RED);
#if defined(CODEPULSE_EPD_RED_BW_ONLY) && CODEPULSE_EPD_RED_BW_ONLY
  epd_canvas_draw_text(c, 12, 84, "1 CPU 25 TO 75 / 2 BACK", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 102, "RED AND OUTSIDE MUST STAY", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  epd_canvas_draw_text(c, 12, 84, "1 MOVE RED / 2 ERASE / 3 ADD RED", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 102, "OUTSIDE RED AND BLACK MUST STAY", 1, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 84, "1 MOVE RED / 2 REMOVE RED", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 102, "OBSERVE ONLY THE BAND BELOW", 1, EPD_COLOR_BLACK);
#endif
  epd_canvas_fill_rect(c, 0, 124, 400, 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 0, 170, 400, 2, EPD_COLOR_BLACK);
#if defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  const bool show_red = frame != 2;
#else
  const bool show_red = frame < 2;
#endif
  if (show_red) {
    const unsigned x = frame == 1 ? 208u : 16u;
    epd_canvas_fill_rect(c, x, 132, 176, 32, EPD_COLOR_RED);
    epd_canvas_draw_text(c, x + 8, 140, frame == 1 ? "ERROR" : "WAIT", 2, EPD_COLOR_WHITE);
  } else {
    epd_canvas_draw_text(c, 24, 140, "READY / RED CLEARED", 2, EPD_COLOR_BLACK);
  }
#if defined(CODEPULSE_EPD_RED_BW_ONLY) && CODEPULSE_EPD_RED_BW_ONLY
  epd_canvas_draw_text(c, 12, 181, "NEXT PRESS CHANGES ONLY CPU", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  epd_canvas_draw_text(c, 12, 181, "EVERY STEP CHANGES RED PIXELS", 1, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 181, "3 CPU UP / 4 CPU BACK (BW)", 1, EPD_COLOR_BLACK);
#endif
#if defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  epd_canvas_draw_text(c, 24, 206, "BLACK CONTROL - KEEP", 2, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 24, 206, frame == 3 ? "CPU 75%" : "CPU 25%", 3, EPD_COLOR_BLACK);
#endif
  epd_canvas_fill_rect(c, 320, 202, 56, 28, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 244, "BOTTOM RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_draw_text(c, 12, 269, "WAIT 180S THEN SHORT PRESS ONCE", 1, EPD_COLOR_BLACK);
#if defined(CODEPULSE_EPD_RED_BW_ONLY) && CODEPULSE_EPD_RED_BW_ONLY
  epd_canvas_draw_text(c, 12, 283, "AFTER CPU BACK: NEXT PRESS RETURNS TO APP", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  epd_canvas_draw_text(c, 12, 283, "AFTER RED RETURNS: NEXT PRESS RESUMES APP", 1, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 283, "AFTER STEP 4: NEXT PRESS RETURNS TO APP", 1, EPD_COLOR_BLACK);
#endif
  return true;
}

esp_err_t red_probe_validate(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, bool bw_only) {
  if (!c || !c->black || !c->red || !old_black || !old_red ||
      c->black == old_black || c->red == old_red ||
      size != EPD_CANVAS_BUFFER_SIZE || !height ||
      y >= BOARD_EPD_HEIGHT || height > BOARD_EPD_HEIGHT - y)
    return ESP_ERR_INVALID_ARG;
  const size_t first = y * 50u, end = (y + height) * 50u;
  for (size_t i = 0; i < size; ++i) {
    /* A red pixel must have its BW bit white, in both actual frame histories. */
    if (((uint8_t)~c->black[i] & (uint8_t)~c->red[i]) ||
        ((uint8_t)~old_black[i] & (uint8_t)~old_red[i])) return ESP_ERR_INVALID_ARG;
    if ((i < first || i >= end) &&
        (c->black[i] != old_black[i] || c->red[i] != old_red[i])) return ESP_ERR_INVALID_ARG;
    if (bw_only && (c->red[i] != old_red[i] ||
        (i >= first && i < end && c->red[i] != 0xff))) return ESP_ERR_INVALID_ARG;
  }
  return ESP_OK;
}
