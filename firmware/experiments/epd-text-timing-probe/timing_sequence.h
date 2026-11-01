#pragma once
#include <string.h>
#include "timing_pattern.h"

#define TIMING_PROBE_STEP_COUNT 5u /* one OTP baseline + four manual updates */
typedef struct {
  unsigned next_step;
  bool stopped;
} timing_probe_state_t;

/* Called only after a short press and cooldown in the task below. OLD is the
 * last successfully transmitted target, not an optical measurement. The human
 * operator must stop if readability fails or outside references change. */
static esp_err_t timing_probe_render_step(timing_probe_state_t *state,
    epd_canvas_t *canvas, uint8_t *previous, size_t previous_size,
    epd_timing_metrics_t *metrics) {
  if (!state || !canvas || !canvas->black || !canvas->red || !previous ||
      previous_size != EPD_CANVAS_BUFFER_SIZE || !metrics)
    return ESP_ERR_INVALID_ARG;
  if (state->stopped || state->next_step >= TIMING_PROBE_STEP_COUNT)
    return ESP_ERR_INVALID_STATE;
  const bool baseline = state->next_step == 0;
  timing_probe_pattern(canvas, (state->next_step & 1u) != 0);
  const esp_err_t result = epd_timing_probe_refresh(canvas,
      baseline ? NULL : previous, previous_size,
      baseline ? TIMING_OTP_BASELINE : TIMING_PAIR125, metrics);
  if (result != ESP_OK) {
    state->stopped = true;
    return result;
  }
  memcpy(previous, canvas->black, previous_size);
  ++state->next_step;
  state->stopped = state->next_step >= TIMING_PROBE_STEP_COUNT;
  return ESP_OK;
}
