/* Diagnostic actual-red changes only. Keep the known full-BWR session, load
 * both complete target planes outside partial mode, then gate only one band.
 * No reset, sleep, LUT/PLL/voltage edits, OTP programming, retry or fallback. */
esp_err_t epd_red_probe_region(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, epd_quiet_metrics_t *m) {
  if (m) memset(m, 0, sizeof(*m));
  if (!m || !s_spi || red_probe_validate(c, old_black, old_red, size, y, height, false) != ESP_OK)
    return ESP_ERR_INVALID_ARG;
  /* This experiment must exercise red, never silently substitute a BW update. */
  if (!memcmp(c->red, old_red, size)) return ESP_ERR_INVALID_ARG;
  if (!s_epd_baseline_valid) return ESP_ERR_INVALID_STATE;
  s_epd_baseline_valid = false;
  if (gpio_get_level(PIN_EPD_BUSY) == 0) return ESP_ERR_INVALID_STATE;
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300, "Board1 only");
  const int64_t started = esp_timer_get_time();
  int64_t phase = started;
  bool entered = false;
  m->x = 0; m->width = BOARD_EPD_WIDTH;
  const uint8_t boost[] = {0x17, 0x17, 0x17};
  const uint8_t otp_bwr = 0x0f, floating_border = 0xf7;
  const uint8_t resolution[] = {1, 144, 1, 44};
  esp_err_t result = epd_command_data(0x06, boost, sizeof(boost));
  if (result == ESP_OK) result = epd_command_data(0x00, &otp_bwr, 1);
  if (result == ESP_OK) result = epd_command_data(0x50, &floating_border, 1);
  if (result == ESP_OK) result = epd_command_data(0x61, resolution, sizeof(resolution));
  if (result == ESP_OK) result = epd_command(0x04);
  if (result == ESP_OK) result = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  m->init_ms = quiet_elapsed_ms(phase);
  phase = esp_timer_get_time();
  /* Explicitly leave partial RAM addressing before uploading full row strides.
   * No display-refresh command is issued for this whole-frame RAM transfer. */
  if (result == ESP_OK) result = epd_command(0x92);
  if (result == ESP_OK) result = epd_command_data(0x10, c->black, size);
  if (result == ESP_OK) result = epd_command_data(0x13, c->red, size);
  if (result == ESP_OK) {
    result = epd_command(0x91);
    entered = result == ESP_OK;
  }
  const unsigned last = y + height - 1u;
  const uint8_t window[] = {0, 0, 1, 143, (uint8_t)(y >> 8), (uint8_t)y,
      (uint8_t)(last >> 8), (uint8_t)last, 0};
  if (result == ESP_OK) result = epd_command_data(0x90, window, sizeof(window));
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
