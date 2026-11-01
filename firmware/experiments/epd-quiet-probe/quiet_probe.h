#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "epd_canvas.h"

typedef struct {
  uint32_t init_ms, upload_ms, refresh_ms, off_ms, total_ms;
  uint32_t busy_assert_ms, busy_low_ms;
  bool busy_seen;
} epd_quiet_metrics_t;

typedef enum {
  QUIET_OTP_BASELINE = 0,
  QUIET_REFERENCE = 1,
  QUIET_LONG_PAIR = 2,
} epd_quiet_phase_t;

#define QUIET_WINDOW_HEIGHT 40u
#define QUIET_ROW_A 96u
#define QUIET_ROW_B 184u

/* A and B start from separate areas of the same clean OTP baseline.
 * No reverse update may depend on a visually failed previous result. */
esp_err_t epd_quiet_probe_refresh(const epd_canvas_t *canvas,
    const uint8_t *previous, size_t previous_size, epd_quiet_phase_t phase,
    epd_quiet_metrics_t *metrics);
void codepulse_quiet_probe_run(uint32_t short_event, uint32_t long_event);
