#pragma once
#include <stdbool.h>
#include "epd_quiet.h"

#define RED_LUT_BAND_Y 128u
#define RED_LUT_BAND_HEIGHT 40u
#define RED_LUT_COOLDOWN_MS INT64_C(180000)
#define RED_LUT_LAST_FRAME 2u

typedef enum {
  RED_LUT_FULL = 1,
  RED_LUT_SHORT = 2,
} red_lut_profile_t;

/* Diagnostic only: a successful command sequence is not optical acceptance. */
bool red_lut_draw(epd_canvas_t *canvas, unsigned frame);
esp_err_t red_lut_validate(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height);
esp_err_t epd_red_lut_refresh(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, red_lut_profile_t profile,
    epd_quiet_metrics_t *metrics);
bool codepulse_red_lut_run(epd_canvas_t *canvas,
    uint32_t short_event, uint32_t long_event);
