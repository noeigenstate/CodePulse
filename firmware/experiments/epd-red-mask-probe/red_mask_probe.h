#pragma once
#include <stdbool.h>
#include "epd_quiet.h"

#define RED_MASK_X 160u
#define RED_MASK_Y 130u
#define RED_MASK_WIDTH 80u
#define RED_MASK_HEIGHT 28u
#define RED_MASK_COOLDOWN_MS INT64_C(180000)
#define RED_MASK_LAST_FRAME 2u
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
#define RED_MASK_INITIAL_FRAME 1u
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
/* All seven .39 red phases, with conditioning repeats 1/1/1. This is not
 * the optically accepted .39 sequence; the reduced conditioning is a trial. */
#ifdef CODEPULSE_EPD_RED_MASK_FAST
#define RED_MASK_RED_ACTIVATE_FRAMES 854u /* at 200Hz, still nominally 4270ms */
#else
#define RED_MASK_RED_ACTIVATE_FRAMES 427u
#endif
#define RED_MASK_PAINT_GATE_MS 7500u
#define RED_MASK_PAINT_PASS_GATE_MS(pass) ((pass)==0?5200u:3500u)
#ifdef CODEPULSE_EPD_RED_MASK_FAST
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"FAST_RED_TAIL":"WHITE_GLYPHS")
#else
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"CONDITION_AND_RED":"WHITE_GLYPHS")
#endif
#elif defined(CODEPULSE_EPD_RED_MASK_PULSE)
/* Exact .39 red tail: (4+16)*5 + (3+14)*10 + 35, then one neutral frame.
 * Preserve pulse order/repetition; total drive time is not interchangeable. */
#define RED_MASK_RED_PULSE_FRAMES 306u
#define RED_MASK_PAINT_GATE_MS 6500u
#define RED_MASK_PAINT_PASS_GATE_MS(pass) ((pass)==0?3500u:4200u)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"CLEAR_FOR_RED":"SEGMENTED_RED")
#else
#define RED_MASK_PAINT_GATE_MS 5000u
#define RED_MASK_PAINT_PASS_GATE_MS(pass) 3500u
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"CLEAR_FOR_RED":"RED_ONLY")
#endif
#else
#define RED_MASK_INITIAL_FRAME 0u
#define RED_MASK_PAINT_GATE_MS 6500u
#define RED_MASK_PAINT_PASS_GATE_MS(pass) 6500u
#define RED_MASK_PAINT_PHASE(pass) "DRAW_RED"
#endif
/* Experimental single-direction dwell: .39 SHORT's accumulated VDH/VDL
 * budget for W/B is 178 frames each. Red tail VDHR totals 255 frames.
 * These are bounds for a new hypothesis, NOT a validated optical equivalent. */
#define RED_MASK_BW_FRAMES 178u
#define RED_MASK_RED_FRAMES 255u
#ifdef CODEPULSE_EPD_RED_MASK_BLACK
/* One black-only dwell, capped at the already exercised PAIR150 source hold.
 * Reusing a duration does NOT qualify this different optical sequence. */
#define RED_MASK_BLACK_FRAMES 150u
#define RED_MASK_ERASE_GATE_MS 4500u
#else
#define RED_MASK_ERASE_GATE_MS 3500u
#endif
typedef enum { RED_MASK_ERASE=1, RED_MASK_PAINT=2 } red_mask_operation_t;
typedef struct {
  red_mask_operation_t operation;
  unsigned hold_pixels, white_pixels, black_pixels, red_pixels;
  unsigned red_removed, red_added;
} red_mask_plan_t;
bool red_mask_draw(epd_canvas_t *canvas, unsigned frame);
esp_err_t red_mask_prepare(red_mask_plan_t *plan, const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height);
void red_mask_encode(uint8_t black, uint8_t red, uint8_t old_black, uint8_t old_red,
    uint8_t *mask_black, uint8_t *mask_red);
size_t red_mask_make_lut(unsigned slot, const red_mask_plan_t *plan, uint8_t out[44]);
unsigned red_mask_frames(const red_mask_plan_t *plan);
unsigned red_mask_nominal_ms(const red_mask_plan_t *plan);
esp_err_t epd_red_mask_refresh(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height, epd_quiet_metrics_t *metrics);
bool codepulse_red_mask_run(epd_canvas_t *canvas, uint32_t short_event, uint32_t long_event);

#ifdef CODEPULSE_EPD_RED_MASK_BLACK
unsigned red_black_pass_count(const red_mask_plan_t *plan);
unsigned red_black_pass_frames(const red_mask_plan_t *plan, unsigned pass);
unsigned red_black_pass_hz(const red_mask_plan_t *plan, unsigned pass);
void red_black_encode(const red_mask_plan_t *plan, unsigned pass,
    uint8_t black, uint8_t red, uint8_t old_black, uint8_t old_red,
    uint8_t *mask_black, uint8_t *mask_red);
size_t red_black_make_lut(unsigned table, const red_mask_plan_t *plan,
    unsigned pass, uint8_t out[44]);
#endif

#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
/* in_window is byte-aligned and checked by the driver. Only the final white
 * glyph cleanup intentionally drives unchanged WHITE pixels in that window. */
void red_activation_encode(unsigned pass, bool in_window,
    uint8_t black,uint8_t red,uint8_t old_black,uint8_t old_red,
    uint8_t *mask_black,uint8_t *mask_red);
#endif
