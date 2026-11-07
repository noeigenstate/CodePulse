#include "red_badge_probe.h"

bool red_badge_draw(epd_canvas_t *c, unsigned frame) {
  if (!c || !c->black || !c->red || frame > RED_BADGE_LAST_FRAME) return false;
  epd_canvas_clear(c, EPD_COLOR_WHITE);
  epd_canvas_draw_text(c, 12, 12, RED_BADGE_TITLE, 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 48, "TOP RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(c, 368, 44, 20, 28, EPD_COLOR_RED);
  epd_canvas_draw_text(c, 12, 84, "1 RED ERASES / 2 RED RETURNS", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 102, RED_BADGE_CAPTION, 1, EPD_COLOR_BLACK);
  /* Same-row controls are outside the horizontal window. They must neither
   * flash nor fade; a narrow address window alone is not proof of isolation. */
  epd_canvas_draw_text(c, 20, 137, "BLACK", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 276, 137, "RED", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(c, 154, 124, 92, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 154, 163, 92, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 154, 124, 1, 40, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 245, 124, 1, 40, EPD_COLOR_BLACK);
  if (frame != 1) {
    epd_canvas_fill_rect(c, RED_BADGE_X, RED_BADGE_Y,
        RED_BADGE_WIDTH, RED_BADGE_HEIGHT, EPD_COLOR_RED);
    epd_canvas_draw_text(c, frame == 0 ? 176 : 170, 137,
        frame == 0 ? "WAIT" : "ERROR", 2, EPD_COLOR_WHITE);
  } else {
    epd_canvas_draw_text(c, 170, 137, "READY", 2, EPD_COLOR_BLACK);
  }
  epd_canvas_draw_text(c, 12, 181, "SIDE / TOP / BOTTOM MUST STAY STILL", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 24, 206, "BLACK CONTROL - KEEP", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 248, "BOTTOM RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_draw_text(c, 12, 283, "AFTER STEP 2: NEXT PRESS RETURNS TO APP", 1, EPD_COLOR_BLACK);
  return true;
}

esp_err_t red_badge_validate(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height) {
  if (!c || !c->black || !c->red || !old_black || !old_red ||
      c->black == c->red || old_black == old_red ||
      c->black == old_black || c->black == old_red ||
      c->red == old_black || c->red == old_red ||
      size != EPD_CANVAS_BUFFER_SIZE || height < 2 || width < 16 ||
      x >= BOARD_EPD_WIDTH || width > BOARD_EPD_WIDTH-x ||
      y >= BOARD_EPD_HEIGHT || height > BOARD_EPD_HEIGHT-y ||
      x % 8 || width % 8)
    return ESP_ERR_INVALID_ARG;
  /* R90 horizontal bank end must exceed start: at least 16 aligned pixels. */
  const unsigned first_byte=x/8u, end_byte=(x+width)/8u;
  bool red_changed = false;
  for (size_t i=0; i<size; ++i) {
    if (((uint8_t)~c->black[i] & (uint8_t)~c->red[i]) ||
        ((uint8_t)~old_black[i] & (uint8_t)~old_red[i])) return ESP_ERR_INVALID_ARG;
    const size_t row=i/50u, col=i%50u;
    const bool inside = row>=y && row<y+height && col>=first_byte && col<end_byte;
    if (!inside && (c->black[i] != old_black[i] || c->red[i] != old_red[i]))
      return ESP_ERR_INVALID_ARG;
    red_changed |= c->red[i] != old_red[i];
  }
  /* Static-red/BW-only updates are deliberately not a substitute. */
  return red_changed ? ESP_OK : ESP_ERR_INVALID_ARG;
}
