#include "red_mask_probe.h"

bool red_mask_draw(epd_canvas_t *c, unsigned frame) {
  if (!c || !c->black || !c->red || frame > RED_MASK_LAST_FRAME) return false;
  epd_canvas_clear(c, EPD_COLOR_WHITE);
#if defined(CODEPULSE_EPD_RED_MASK_CRISP_AB)
  epd_canvas_draw_text(c, 12, 12, "RED CRISP AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_VIVID_AB)
  epd_canvas_draw_text(c, 12, 12, "RED VIVID AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_SMOOTH_AB)
  epd_canvas_draw_text(c, 12, 12, "RED SMOOTH AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  epd_canvas_draw_text(c, 12, 12, "RED RICH AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
  epd_canvas_draw_text(c, 12, 12, "RED FREQ AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
  epd_canvas_draw_text(c, 12, 12, "RED WAVE AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
  epd_canvas_draw_text(c, 12, 12, "RED BRAKE AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
  epd_canvas_draw_text(c, 12, 12, "RED PURE AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
  epd_canvas_draw_text(c, 12, 12, "RED GLIDE AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
  epd_canvas_draw_text(c, 12, 12, "RED SINGLE AB LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_GAP_SHIFT)
  epd_canvas_draw_text(c, 12, 12, "RED GAP SHIFT LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_FINISH)
  epd_canvas_draw_text(c, 12, 12, "RED FINISH LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_PAIR)
  epd_canvas_draw_text(c, 12, 12, "RED PAIR LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
  epd_canvas_draw_text(c, 12, 12, "RED GAP LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_STAGGER)
  epd_canvas_draw_text(c, 12, 12, "RED STAGGER LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_NEUTRAL)
  epd_canvas_draw_text(c, 12, 12, "RED NEUTRAL LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
  epd_canvas_draw_text(c, 12, 12, "RED SPLIT LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL100)
  epd_canvas_draw_text(c, 12, 12, "RED TAIL100 LAB", 3, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
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
#if defined(CODEPULSE_EPD_RED_MASK_CRISP_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS CRISP: A 860MS / B 830MS", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_VIVID_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS VIVID: A HOLD / B VDH+HOLD", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_SMOOTH_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS SMOOTH: A 18.2HZ / B 20HZ", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS RICH: A 16.7HZ / B 20HZ", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS FREQ: A 20HZ / B 200HZ 5MS", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS WAVE: A 3.00S / B 2.90S", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS BRAKE: A 2.80S / B 2.65S", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS PURE: A 2.90S / B 2.68S", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS GLIDE: A 2.80S / B 2.30S", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
  epd_canvas_draw_text(c, 12, 102, "1-PASS R22+R24: A 4.47S / B 3.80S", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_GAP_SHIFT)
  epd_canvas_draw_text(c, 12, 102, "100HZ RED TAIL - SHIFTED GAPS", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_FINISH)
  epd_canvas_draw_text(c, 12, 102, "100HZ RED TAIL - CONTINUOUS FINISH", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_PAIR)
  epd_canvas_draw_text(c, 12, 102, "100HZ PAIRED RED TAIL - WHITE LAST", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
  epd_canvas_draw_text(c, 12, 102, "100HZ RED TAIL GAP - WHITE LAST", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_STAGGER)
  epd_canvas_draw_text(c, 12, 102, "100HZ STAGGERED PIXELS - WHITE LAST", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_NEUTRAL)
  epd_canvas_draw_text(c, 12, 102, "100HZ RED PULSES - NO TAIL REVERSAL", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
  epd_canvas_draw_text(c, 12, 102, "100HZ PREFIX / 200HZ TAIL / WHITE LAST", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL100)
  epd_canvas_draw_text(c, 12, 102, "100HZ PREFIX - 50/60MS RED TAIL", 1, EPD_COLOR_BLACK);
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
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
