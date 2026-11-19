#include "red_lut5_probe.h"
#include <string.h>

bool red_lut5_draw(epd_canvas_t *c, unsigned frame) {
  if (!c || !c->black || !c->red || frame > RED_LUT5_LAST_FRAME) return false;
  epd_canvas_clear(c, EPD_COLOR_WHITE);
  epd_canvas_draw_text(c, 12, 12, "RED LUT5 LAB", 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 48, "TOP RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(c, 368, 44, 20, 28, EPD_COLOR_RED);
  epd_canvas_draw_text(c, 12, 84, "1 ERASE ALL RED / 2 RED RETURNS", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 102, "ALL FIVE LUT SLOTS ARE WRITTEN", 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 0, 124, 400, 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 0, 170, 400, 2, EPD_COLOR_BLACK);
  for (unsigned side=0; side<2; ++side) {
    const int x = side == 0 ? 16 : 208;
    const bool is_red = (frame == 0 && side == 0) || (frame == 2 && side == 1);
    if (is_red) {
      epd_canvas_fill_rect(c, x, 130, 176, 36, EPD_COLOR_RED);
      epd_canvas_draw_text(c, x+12, 138, side ? "ERROR" : "WAIT", 3, EPD_COLOR_WHITE);
    } else {
      epd_canvas_draw_text(c, x+12, 138, "READY", 3, EPD_COLOR_BLACK);
    }
  }
  epd_canvas_draw_text(c, 12, 181, "ONLY THE MIDDLE BAND MAY CHANGE", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 24, 206, "BLACK CONTROL - KEEP", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 248, "BOTTOM RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_draw_text(c, 12, 283, "AFTER STEP 2: NEXT PRESS RETURNS TO APP", 1, EPD_COLOR_BLACK);
  return true;
}

esp_err_t red_lut5_validate(const epd_canvas_t *c,
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
