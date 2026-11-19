/* Included after the production quiet driver, only in RED_REGION_PROBE builds.
 * OTP regional BWR is a spatial experiment, not a faster colour waveform.
 * No OTP programming, voltage change, shortened wait or automatic fallback. */
#include "red_probe.h"

#if defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
#include "driver_red_retained.inc"
#else
esp_err_t epd_red_probe_region(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, epd_quiet_metrics_t *m) {
  if (m) memset(m, 0, sizeof(*m));
  if (!m || !s_spi || red_probe_validate(c, old_black, old_red, size, y, height, false) != ESP_OK)
    return ESP_ERR_INVALID_ARG;
  if (!s_epd_baseline_valid) return ESP_ERR_INVALID_STATE;
  s_epd_baseline_valid = false;
  if (gpio_get_level(PIN_EPD_BUSY) == 0) return ESP_ERR_INVALID_STATE;
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300, "Board1 only");
  const int64_t started = esp_timer_get_time();
  int64_t phase = started;
  bool entered = false;
  m->x = 0; m->width = BOARD_EPD_WIDTH;
  esp_err_t result = epd_panel_wake_and_configure();
  m->init_ms = quiet_elapsed_ms(phase);
  phase = esp_timer_get_time();
  if (result == ESP_OK) {
    result = epd_command(0x91);
    entered = result == ESP_OK;
  }
  const unsigned last = y + height - 1u;
  const uint8_t window[] = {0, 0, 1, 143, (uint8_t)(y >> 8), (uint8_t)y,
      (uint8_t)(last >> 8), (uint8_t)last, 0};
  if (result == ESP_OK) result = epd_command_data(0x90, window, sizeof(window));
  if (result == ESP_OK) result = epd_command_data(0x10, c->black + y * 50u, height * 50u);
  if (result == ESP_OK) result = epd_command_data(0x13, c->red + y * 50u, height * 50u);
  m->upload_ms = quiet_elapsed_ms(phase);
  phase = esp_timer_get_time();
  if (result == ESP_OK) result = epd_command(0x12);
  if (result == ESP_OK) result = quiet_wait_refresh(m);
  m->refresh_ms = quiet_elapsed_ms(phase);
  phase = esp_timer_get_time();
  if (entered && gpio_get_level(PIN_EPD_BUSY) != 0) {
    const esp_err_t exit_error = epd_command(0x92);
    if (result == ESP_OK) result = exit_error;
  }
  const esp_err_t off_error = epd_power_off();
  if (result == ESP_OK) result = off_error;
  m->off_ms = quiet_elapsed_ms(phase);
  m->total_ms = quiet_elapsed_ms(started);
  s_epd_baseline_valid = result == ESP_OK;
  return result;
}

#endif

esp_err_t epd_red_probe_bw(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, epd_quiet_metrics_t *m) {
  if (m) memset(m, 0, sizeof(*m));
  if (!m || red_probe_validate(c, old_black, old_red, size, y, height, true) != ESP_OK)
    return ESP_ERR_INVALID_ARG;
  /* Explicit optical experiment: the selected entire gate band is red-free;
   * the physical red outside it must stay unchanged. BW OLD/NEW uses 0x13 as
   * NEW, so supply no red RAM to the strict production BW driver. Never mutate
   * the real red target/history or relax that driver's all-white-red guard.
   * Success is only a transport receipt, not proof that static red survived. */
  static uint8_t no_red[EPD_CANVAS_BUFFER_SIZE];
  memset(no_red, 0xff, sizeof(no_red));
  const epd_canvas_t bw = {.black = c->black, .red = no_red};
  return epd_quiet_refresh(&bw, old_black, size, y, height, m);
}
