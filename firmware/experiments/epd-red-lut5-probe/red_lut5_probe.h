#pragma once
#include <stdbool.h>
#include "epd_quiet.h"

#define RED_LUT5_BAND_Y 128u
#define RED_LUT5_BAND_HEIGHT 40u
#define RED_LUT5_COOLDOWN_MS INT64_C(180000)
#define RED_LUT5_LAST_FRAME 2u

typedef enum {
  RED_LUT5_FULL = 1,
  RED_LUT5_SHORT = 2,
} red_lut5_profile_t;

/* Diagnostic only: a successful command sequence is not optical acceptance. */
bool red_lut5_draw(epd_canvas_t *canvas, unsigned frame);
esp_err_t red_lut5_validate(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height);
esp_err_t epd_red_lut5_refresh(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, red_lut5_profile_t profile,
    epd_quiet_metrics_t *metrics);
bool codepulse_red_lut5_run(epd_canvas_t *canvas,
    uint32_t short_event, uint32_t long_event);
