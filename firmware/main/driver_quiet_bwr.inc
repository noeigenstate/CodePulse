/* Opt-in Board1 production dynamic BWR driver: .67 Crisp860A + .43 Erase.
 * Included inside epd_ssd1683.c after driver_quiet.inc when enabled. */
#include "quiet_bwr_plan.h"

esp_err_t epd_quiet_bwr_refresh(const epd_canvas_t *canvas,
    const uint8_t *old_black, const uint8_t *old_red, size_t previous_size,
    unsigned *out_y, unsigned *out_height, epd_quiet_metrics_t *metrics) {
  if (metrics != NULL) {
    memset(metrics, 0, sizeof(*metrics));
  }
  quiet_bwr_plan_t plan;
  if (metrics == NULL || out_y == NULL || out_height == NULL || s_spi == NULL ||
      quiet_bwr_prepare(&plan, canvas, old_black, old_red, previous_size) != ESP_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_y = plan.y;
  *out_height = plan.height;
  metrics->x = plan.x;
  metrics->width = plan.width;
  if (!s_epd_baseline_valid) {
    return ESP_ERR_INVALID_STATE;
  }
  s_epd_baseline_valid = false;
  if (gpio_get_level(PIN_EPD_BUSY) == 0) {
    return ESP_ERR_INVALID_STATE;
  }
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300,
                 "quiet_bwr is qualified only on Board1");

  const int64_t started = esp_timer_get_time();
  int64_t phase_start = started;
  bool entered = false;
  const uint8_t boost[] = {0x17, 0x17, 0x17};
  const uint8_t psr = 0x2Fu;
  const uint8_t pll = 0x3Au;
  const uint8_t cdi = 0xF7u;
  const uint8_t resolution[] = {1u, 144u, 1u, 44u};
  const unsigned last_x = plan.x + plan.width - 1u;
  const unsigned last_y = plan.y + plan.height - 1u;
  const uint8_t window[] = {
      (uint8_t)(plan.x >> 8), (uint8_t)plan.x,
      (uint8_t)(last_x >> 8), (uint8_t)last_x,
      (uint8_t)(plan.y >> 8), (uint8_t)plan.y,
      (uint8_t)(last_y >> 8), (uint8_t)last_y,
      1u, /* PT_SCAN=1 avoids horizontal band seams outside the window. */
  };

  esp_err_t result = epd_command_data(0x06, boost, sizeof(boost));
  if (result == ESP_OK) result = epd_command(0x04);
  if (result == ESP_OK) result = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  if (result == ESP_OK) result = epd_command_data(0x00, &psr, 1);
  if (result == ESP_OK) result = epd_command_data(0x30, &pll, 1);
  if (result == ESP_OK) result = epd_command_data(0x50, &cdi, 1);
  if (result == ESP_OK) result = epd_command_data(0x61, resolution, sizeof(resolution));
  metrics->init_ms = quiet_elapsed_ms(phase_start);

  for (unsigned pass = 0u; result == ESP_OK && pass < plan.pass_count; ++pass) {
    const quiet_bwr_phase_t phase = plan.passes[pass];
    phase_start = esp_timer_get_time();
    result = epd_command(0x92);
    for (unsigned plane = 0u; result == ESP_OK && plane < 2u; ++plane) {
      result = epd_command(plane != 0u ? 0x13u : 0x10u);
      uint8_t chunk[5u * (BOARD_EPD_WIDTH / 8u)];
      uint8_t discard[BOARD_EPD_WIDTH / 8u];
      for (unsigned row_base = 0u;
           result == ESP_OK && row_base < BOARD_EPD_HEIGHT; row_base += 5u) {
        for (unsigned r = 0u; r < 5u; ++r) {
          uint8_t *dst = chunk + r * (BOARD_EPD_WIDTH / 8u);
          if (plane == 0u) {
            quiet_bwr_encode_row(phase, row_base + r, canvas->black, canvas->red,
                                 old_black, old_red, dst, discard);
          } else {
            quiet_bwr_encode_row(phase, row_base + r, canvas->black, canvas->red,
                                 old_black, old_red, discard, dst);
          }
        }
        result = epd_transmit(chunk, sizeof(chunk), 1);
      }
    }
    uint8_t lut[44];
    for (unsigned table = 0u; result == ESP_OK && table < 5u; ++table) {
      const size_t length = quiet_bwr_make_lut(table, phase, lut);
      if (length != (table != 0u ? 42u : 44u)) {
        result = ESP_ERR_INVALID_ARG;
        break;
      }
      result = epd_command_data((uint8_t)(0x20u + table), lut, length);
    }
    if (result == ESP_OK) {
      result = epd_command(0x91);
      entered = (result == ESP_OK);
    }
    if (result == ESP_OK) result = epd_command_data(0x90, window, sizeof(window));
    metrics->upload_ms += quiet_elapsed_ms(phase_start);

    phase_start = esp_timer_get_time();
    epd_quiet_metrics_t measured = {0};
    if (result == ESP_OK) result = epd_command(0x12);
    if (result == ESP_OK) result = quiet_wait_refresh(&measured);
    const uint32_t driven_ms = quiet_elapsed_ms(phase_start);
    metrics->refresh_ms += driven_ms;
    metrics->busy_seen |= measured.busy_seen;
    metrics->busy_low_ms += measured.busy_low_ms;
    if (pass == 0u) metrics->busy_assert_ms = measured.busy_assert_ms;
    ESP_LOGI(TAG, "quiet_bwr pass=%u/%u phase=%s frames=%u refresh=%" PRIu32
             " busy=%d result=%s",
             pass + 1u, plan.pass_count, quiet_bwr_phase_name(phase),
             quiet_bwr_pass_frames(phase), driven_ms, measured.busy_seen,
             esp_err_to_name(result));
    if (result == ESP_OK && driven_ms >= quiet_bwr_pass_gate_ms(phase)) {
      result = ESP_ERR_INVALID_RESPONSE;
    }
    if (entered && gpio_get_level(PIN_EPD_BUSY) != 0) {
      const esp_err_t exit_error = epd_command(0x92);
      if (result == ESP_OK) result = exit_error;
      entered = false;
    }
  }

  phase_start = esp_timer_get_time();
  const esp_err_t off_error = epd_power_off();
  if (result == ESP_OK) result = off_error;
  if (result == ESP_OK) result = epd_command_data(0x10, canvas->black, previous_size);
  if (result == ESP_OK) result = epd_command_data(0x13, canvas->red, previous_size);
  gpio_set_level(PIN_EPD_CS, 1);
  gpio_set_level(PIN_EPD_DC, 0);
  metrics->off_ms = quiet_elapsed_ms(phase_start);
  metrics->total_ms = quiet_elapsed_ms(started);
  s_epd_baseline_valid = (result == ESP_OK);
  return result;
}
