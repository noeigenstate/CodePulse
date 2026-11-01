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
} epd_timing_metrics_t;

typedef enum {
  TIMING_OTP_BASELINE = 0,
  TIMING_PAIR125 = 1,
  TIMING_PAIR150 = 2,
} epd_timing_phase_t;

#define TIMING_WINDOW_HEIGHT 40u
#define TIMING_ROW_A 96u
#define TIMING_ROW_B 184u

/* A and B start from separate areas of the same clean OTP baseline.
 * Each area is updated once. No reverse update or inferred optical OLD. */
esp_err_t epd_timing_probe_refresh(const epd_canvas_t *canvas,
    const uint8_t *previous, size_t previous_size, epd_timing_phase_t phase,
    epd_timing_metrics_t *metrics);
void codepulse_timing_probe_run(uint32_t short_event, uint32_t long_event);
