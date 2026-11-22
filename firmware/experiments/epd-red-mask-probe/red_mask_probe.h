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
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#if defined(CODEPULSE_EPD_RED_MASK_CRISP_AB)
#define RED_MASK_SINGLE_A_FRAMES 300u
#define RED_MASK_SINGLE_B_FRAMES 290u
#elif defined(CODEPULSE_EPD_RED_MASK_VIVID_AB)
#define RED_MASK_SINGLE_A_FRAMES 300u
#define RED_MASK_SINGLE_B_FRAMES 290u
#elif defined(CODEPULSE_EPD_RED_MASK_SMOOTH_AB)
#define RED_MASK_SINGLE_A_FRAMES 300u
#define RED_MASK_SINGLE_B_FRAMES 290u
#elif defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
#define RED_MASK_SINGLE_A_FRAMES 300u
#define RED_MASK_SINGLE_B_FRAMES 290u
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
#define RED_MASK_SINGLE_A_FRAMES 300u
#define RED_MASK_SINGLE_B_FRAMES 590u
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
#define RED_MASK_SINGLE_A_FRAMES 300u
#define RED_MASK_SINGLE_B_FRAMES 290u
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
#define RED_MASK_SINGLE_A_FRAMES 280u
#define RED_MASK_SINGLE_B_FRAMES 265u
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
#define RED_MASK_SINGLE_A_FRAMES 290u
#define RED_MASK_SINGLE_B_FRAMES 268u
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
#define RED_MASK_SINGLE_A_FRAMES 280u
#define RED_MASK_SINGLE_B_FRAMES 230u
#else
#define RED_MASK_SINGLE_A_FRAMES 447u
#define RED_MASK_SINGLE_B_FRAMES 380u
#endif
#define RED_MASK_RED_ACTIVATE_FRAMES RED_MASK_SINGLE_A_FRAMES
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
#define RED_MASK_RED_ACTIVATE_FRAMES 732u /* 122 at 100Hz + 610 at 200Hz */
#define RED_MASK_RED_PASS_COUNT 2u
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
#define RED_MASK_RED_ACTIVATE_FRAMES 854u /* at 200Hz, still nominally 4270ms */
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_FINISH)
#define RED_MASK_RED_ACTIVATE_FRAMES 431u
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
#define RED_MASK_RED_ACTIVATE_FRAMES 447u
#else
#define RED_MASK_RED_ACTIVATE_FRAMES 427u
#endif
#ifndef RED_MASK_RED_PASS_COUNT
#define RED_MASK_RED_PASS_COUNT 1u
#endif
#if defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
#define RED_MASK_PAINT_GATE_MS 3800u
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#define RED_MASK_PAINT_GATE_MS 5200u
#else
#define RED_MASK_PAINT_GATE_MS 7500u
#endif
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
#define RED_MASK_PAINT_PASS_GATE_MS(pass) ((pass)==0?2200u:((pass)==1?4100u:3500u))
#define RED_MASK_SPLIT_RED_GATE_MS 5200u
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"CONDITION100":((pass)==1?"FAST_RED_TAIL":"WHITE_GLYPHS"))
#else
#define RED_MASK_PAINT_PASS_GATE_MS(pass) ((pass)==0?5200u:3500u)
#if defined(CODEPULSE_EPD_RED_MASK_CRISP_AB)
#define RED_MASK_PAINT_PHASE(pass) "CRISP_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"CRISP_830_B":"CRISP_860_A")
#elif defined(CODEPULSE_EPD_RED_MASK_VIVID_AB)
#define RED_MASK_PAINT_PHASE(pass) "VIVID_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"VIVID_VDH_B":"VIVID_HOLD_A")
#elif defined(CODEPULSE_EPD_RED_MASK_SMOOTH_AB)
#define RED_MASK_PAINT_PHASE(pass) "SMOOTH_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"SMOOTH_20HZ_B":"SMOOTH_MIX_A")
#elif defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
#define RED_MASK_PAINT_PHASE(pass) "RICH_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"RICH_FADE_B":"RICH_STEP_A")
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
#define RED_MASK_PAINT_PHASE(pass) "FREQ_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"FREQ_200_B":"FREQ_100_A")
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
#define RED_MASK_PAINT_PHASE(pass) "WAVE_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"WAVE_DENSE_B":"WAVE_OTP_A")
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
#define RED_MASK_PAINT_PHASE(pass) "BRAKE_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"BRAKE_GENTLE_B":"BRAKE_BALANCED_A")
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
#define RED_MASK_PAINT_PHASE(pass) "PURE_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"PURE_FAST_B":"PURE_BALANCED_A")
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
#define RED_MASK_PAINT_PHASE(pass) "GLIDE_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"GLIDE_ZERO_B":"GLIDE_SOFT_A")
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#define RED_MASK_PAINT_PHASE(pass) "SINGLE_PASS_BWR"
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) ((plan).group_b?"SINGLE_FAST_B":"SINGLE_SYNC_A")
#elif defined(CODEPULSE_EPD_RED_MASK_GAP_SHIFT)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"SHIFT_RED_TAIL":"WHITE_GLYPHS")
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_FINISH)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"FINISH_RED_TAIL":"WHITE_GLYPHS")
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_PAIR)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"PAIR_RED_TAIL":"WHITE_GLYPHS")
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"GAP_RED_TAIL":"WHITE_GLYPHS")
#elif defined(CODEPULSE_EPD_RED_MASK_STAGGER)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"STAGGER_RED_TAIL":"WHITE_GLYPHS")
#elif defined(CODEPULSE_EPD_RED_MASK_NEUTRAL)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"NEUTRAL_RED_TAIL":"WHITE_GLYPHS")
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL100)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"TAIL100_RED":"WHITE_GLYPHS")
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"FAST_RED_TAIL":"WHITE_GLYPHS")
#else
#define RED_MASK_PAINT_PHASE(pass) ((pass)==0?"CONDITION_AND_RED":"WHITE_GLYPHS")
#endif
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
#ifndef RED_MASK_PAINT_PHASE_FOR
#define RED_MASK_PAINT_PHASE_FOR(plan, pass) RED_MASK_PAINT_PHASE(pass)
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
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
  bool group_b;
#endif
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
#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
esp_err_t epd_red_mask_refresh_scan_ab(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height,
    bool scan_outside_red, epd_quiet_metrics_t *metrics);
#endif
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
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
void red_stagger_encode(unsigned pass, bool in_window, bool odd_row,
    uint8_t black,uint8_t red,uint8_t old_black,uint8_t old_red,
    uint8_t *mask_black,uint8_t *mask_red);
#endif
#endif
