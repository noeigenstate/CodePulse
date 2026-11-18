#pragma once
#include <stdbool.h>
#include "epd_quiet.h"

#define RED_BADGE_X 160u
#define RED_BADGE_Y 130u
#define RED_BADGE_WIDTH 80u
#define RED_BADGE_HEIGHT 28u
#define RED_BADGE_COOLDOWN_MS INT64_C(180000)
#define RED_BADGE_LAST_FRAME 2u
#if defined(CODEPULSE_EPD_RED_BADGE_HOLD) && CODEPULSE_EPD_RED_BADGE_HOLD
#define RED_BADGE_NOMINAL_FRAMES 757u
#define RED_BADGE_TIMING_LIMIT_MS 10000u
#define RED_BADGE_PROFILE_NAME "long-hold"
#define RED_BADGE_TITLE "RED HOLD LAB"
#define RED_BADGE_CAPTION "80x28 - SINGLE CYCLE / FULL PULSE BUDGET"
#else
#define RED_BADGE_NOMINAL_FRAMES 427u
#define RED_BADGE_TIMING_LIMIT_MS 6500u
#define RED_BADGE_PROFILE_NAME "reduced"
#define RED_BADGE_TITLE "RED BADGE LAB"
#define RED_BADGE_CAPTION "80x28 WINDOW - FEWER GLOBAL REVERSALS"
#endif

/* Diagnostic only. Successful SPI and timing do not establish optical quality. */
bool red_badge_draw(epd_canvas_t *canvas, unsigned frame);
esp_err_t red_badge_validate(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height);
esp_err_t epd_red_badge_refresh(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height,
    epd_quiet_metrics_t *metrics);
bool codepulse_red_badge_run(epd_canvas_t *canvas,
    uint32_t short_event, uint32_t long_event);
