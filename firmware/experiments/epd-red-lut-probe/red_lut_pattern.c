#include "red_lut_probe.h"
#include <string.h>

bool red_lut_draw(epd_canvas_t *c, unsigned frame) {
  if (!c || !c->black || !c->red || frame > RED_LUT_LAST_FRAME) return false;
  epd_canvas_clear(c, EPD_COLOR_WHITE);
  epd_canvas_draw_text(c, 12, 12, "RED LUT LAB", 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 48, "TOP RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(c, 368, 44, 20, 28, EPD_COLOR_RED);
  epd_canvas_draw_text(c, 12, 84, "1 FULL TABLE / 2 FEWER REPEATS", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 102, "OLD RED TO BLACK / NEW RED APPEARS", 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 0, 124, 400, 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 0, 170, 400, 2, EPD_COLOR_BLACK);
  const int red_x = frame == 1 ? 208 : 16;
  const int black_x = frame == 1 ? 16 : 208;
  epd_canvas_fill_rect(c, red_x, 130, 176, 36, EPD_COLOR_RED);
  epd_canvas_draw_text(c, red_x + 12, 138, frame == 1 ? "ERROR" : "WAIT", 3, EPD_COLOR_WHITE);
  /* White around READY proves both red-to-white and red-to-black erasure. */
  epd_canvas_draw_text(c, black_x + 12, 138, "READY", 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 181, "ONLY THE MIDDLE BAND MAY CHANGE", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 24, 206, "BLACK CONTROL - KEEP", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 248, "BOTTOM RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_draw_text(c, 12, 283, "AFTER STEP 2: NEXT PRESS RETURNS TO APP", 1, EPD_COLOR_BLACK);
  return true;
}

esp_err_t red_lut_validate(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height) {
  if (!c || !c->black || !c->red || !old_black || !old_red ||
      c->black == c->red || old_black == old_red ||
      c->black == old_black || c->black == old_red ||
      c->red == old_black || c->red == old_red ||
      size != EPD_CANVAS_BUFFER_SIZE || !height ||
      y >= BOARD_EPD_HEIGHT || height > BOARD_EPD_HEIGHT-y)
    return ESP_ERR_INVALID_ARG;
  const size_t first = y * 50u, end = (y+height) * 50u;
  bool red_changed = false;
  for (size_t i=0; i<size; ++i) {
    if (((uint8_t)~c->black[i] & (uint8_t)~c->red[i]) ||
        ((uint8_t)~old_black[i] & (uint8_t)~old_red[i])) return ESP_ERR_INVALID_ARG;
    if ((i<first || i>=end) &&
        (c->black[i] != old_black[i] || c->red[i] != old_red[i])) return ESP_ERR_INVALID_ARG;
    red_changed |= c->red[i] != old_red[i];
  }
  /* A static-red BW test cannot accidentally satisfy this experiment. */
  return red_changed ? ESP_OK : ESP_ERR_INVALID_ARG;
}
