#include "red_mask_probe.h"

bool red_mask_draw(epd_canvas_t *c, unsigned frame) {
  if (!c || !c->black || !c->red || frame > RED_MASK_LAST_FRAME) return false;
  epd_canvas_clear(c, EPD_COLOR_WHITE);
#if defined(CODEPULSE_EPD_RED_MASK_FAST)
  epd_canvas_draw_text(c, 12, 12, "RED FAST LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_ACTIVATE)
  epd_canvas_draw_text(c, 12, 12, "RED PHASE LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_PULSE)
  epd_canvas_draw_text(c, 12, 12, "RED PULSE LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_COLOR)
  epd_canvas_draw_text(c, 12, 12, "RED COLOR LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_BLACK)
  epd_canvas_draw_text(c, 12, 12, "RED BLACK LAB", 3, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 12, "RED MASK LAB", 3, EPD_COLOR_BLACK);
#endif
  epd_canvas_draw_text(c, 12, 48, "TOP RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(c, 368, 44, 20, 28, EPD_COLOR_RED);
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  epd_canvas_draw_text(c, 12, 84, "ONE PRESS: RED ERROR APPEARS", 1, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 84, "1 RED ERASES / 2 RED RETURNS", 1, EPD_COLOR_BLACK);
#endif
#if defined(CODEPULSE_EPD_RED_MASK_FAST)
  epd_canvas_draw_text(c, 12, 102, "SHORT RED PULSES - WHITE GLYPHS LAST", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_ACTIVATE)
  epd_canvas_draw_text(c, 12, 102, "RED PHASES FIRST - WHITE GLYPHS LAST", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_PULSE)
  epd_canvas_draw_text(c, 12, 102, "SEGMENTED RED TAIL - CHANGED PIXELS", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_COLOR)
  epd_canvas_draw_text(c, 12, 102, "MEASURED RED PULSE AFTER WHITE CLEAR", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_BLACK)
  epd_canvas_draw_text(c, 12, 102, "CLEAR CHANGED PIXELS, THEN WRITE BLACK", 1, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 102, "CHANGED PIXELS ONLY - NO GLOBAL CYCLE", 1, EPD_COLOR_BLACK);
#endif
  /* Same-row controls are outside the horizontal window. They must neither
   * flash nor fade; a narrow address window alone is not proof of isolation. */
  epd_canvas_draw_text(c, 20, 137, "BLACK", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 276, 137, "RED", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(c, 154, 124, 92, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 154, 163, 92, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 154, 124, 1, 40, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 245, 124, 1, 40, EPD_COLOR_BLACK);
  if (frame != 1) {
    epd_canvas_fill_rect(c, RED_MASK_X, RED_MASK_Y,
        RED_MASK_WIDTH, RED_MASK_HEIGHT, EPD_COLOR_RED);
    epd_canvas_draw_text(c, frame == 0 ? 176 : 170, 137,
        frame == 0 ? "WAIT" : "ERROR", 2, EPD_COLOR_WHITE);
  } else {
    epd_canvas_draw_text(c, 170, 137, "READY", 2, EPD_COLOR_BLACK);
  }
  epd_canvas_draw_text(c, 12, 181, "SIDE / TOP / BOTTOM MUST STAY STILL", 1, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 24, 206, "BLACK CONTROL - KEEP", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(c, 12, 248, "BOTTOM RED MUST STAY", 2, EPD_COLOR_RED);
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  epd_canvas_draw_text(c, 12, 283, "AFTER RED CHECK: NEXT PRESS RETURNS", 1, EPD_COLOR_BLACK);
#else
  epd_canvas_draw_text(c, 12, 283, "AFTER STEP 2: NEXT PRESS RETURNS TO APP", 1, EPD_COLOR_BLACK);
#endif
  return true;
}
