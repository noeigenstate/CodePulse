#pragma once
#include "epd_ssd1683.h"
#include <stdbool.h>
#include <stddef.h>

typedef struct {
  uint32_t init_ms, upload_ms, refresh_ms, off_ms, total_ms;
  unsigned x, width;
  bool busy_seen;
  uint32_t busy_assert_ms, busy_low_ms;
} epd_quiet_metrics_t;

/* Board1 BW only. OLD must be the last successful full-frame target.
 * Requires a successful epd_ssd1683_refresh baseline in this controller session.
 * Reset/sleep/driver failure invalidates it; no automatic recovery/full refresh.
 * One window per update; caller serializes display operations. The default
 * remains full width. RECT_TRIAL crops to byte-aligned changed columns. */
esp_err_t epd_quiet_refresh(const epd_canvas_t *canvas,
    const uint8_t *previous, size_t previous_size, unsigned y, unsigned height,
    epd_quiet_metrics_t *metrics);
#if defined(CODEPULSE_QUIET_RED_CRISP_TRIAL) && CODEPULSE_QUIET_RED_CRISP_TRIAL
esp_err_t epd_quiet_bwr_refresh(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t previous_size,
    unsigned *out_y, unsigned *out_height, epd_quiet_metrics_t *metrics);
#endif
