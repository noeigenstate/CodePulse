#pragma once
#include <stdbool.h>
#include "epd_quiet.h"

#define RED_PROBE_COOLDOWN_MS INT64_C(180000)
#if defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
#define RED_PROBE_LAST_FRAME 3u
#else
#define RED_PROBE_LAST_FRAME 4u
#endif
#if defined(CODEPULSE_EPD_RED_BW_ONLY) && CODEPULSE_EPD_RED_BW_ONLY
#define RED_PROBE_FIRST_FRAME 2u
#else
#define RED_PROBE_FIRST_FRAME 0u
#endif
#define RED_PROBE_BAND_Y 128u
#define RED_PROBE_BAND_HEIGHT 40u
#define RED_PROBE_BW_Y 198u
#define RED_PROBE_BW_HEIGHT 40u

/* Diagnostic only. These functions are never linked into a normal build. */
bool red_probe_draw(epd_canvas_t *canvas, unsigned frame);
esp_err_t red_probe_validate(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, bool bw_only);
esp_err_t epd_red_probe_region(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, epd_quiet_metrics_t *metrics);
esp_err_t epd_red_probe_bw(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, epd_quiet_metrics_t *metrics);
/* Short press advances once after cooldown; long press requests safe shutdown.
 * A final short press returns to the unchanged production app. No auto steps. */
bool codepulse_red_probe_run(epd_canvas_t *canvas,
    uint32_t short_event, uint32_t long_event);
