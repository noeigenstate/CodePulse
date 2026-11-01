/* Manual, default-off BW differential experiment. Included in the real driver. */
#include "quiet_probe.h"
#include "quiet_lut.h"

static uint32_t quiet_elapsed_ms(int64_t start) {
  return (uint32_t)((esp_timer_get_time() - start) / 1000);
}

static esp_err_t quiet_wait_refresh(epd_quiet_metrics_t *m) {
  const int64_t start = esp_timer_get_time();
  int64_t first_low = 0;
  for (;;) {
    esp_err_t err = epd_command(0x71);
    if (err != ESP_OK) return err;
    const int64_t now = esp_timer_get_time();
    const bool low = gpio_get_level(PIN_EPD_BUSY) == 0;
    if (low && !m->busy_seen) {
      m->busy_seen = true;
      first_low = now;
      m->busy_assert_ms = (uint32_t)((now - start) / 1000);
    } else if (!low && m->busy_seen) {
      m->busy_low_ms = (uint32_t)((now - first_low) / 1000);
      return ESP_OK;
    }
    if (!m->busy_seen && now - start >= (int64_t)EPD_BUSY_ASSERT_TIMEOUT_MS * 1000)
      return ESP_ERR_INVALID_RESPONSE;
    if (now - start >= (int64_t)EPD_BUSY_TIMEOUT_MS * 1000)
      return ESP_ERR_TIMEOUT;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

static esp_err_t quiet_power_off(void) {
  esp_err_t err = ESP_ERR_INVALID_STATE;
  if (gpio_get_level(PIN_EPD_BUSY) != 0) {
    /* BW DDX=01: old/new differential; border floats. Do not use BWR F7. */
    const uint8_t cdi = 0xD7;
    err = epd_command_data(0x50, &cdi, 1);
    if (err == ESP_OK) err = epd_command(0x02);
    if (err == ESP_OK) err = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  }
  vTaskDelay(pdMS_TO_TICKS(10));
  gpio_set_level(PIN_EPD_CS, 1);
  gpio_set_level(PIN_EPD_DC, 0);
  return err;
}

esp_err_t epd_quiet_probe_refresh(const epd_canvas_t *canvas,
    const uint8_t *previous, size_t previous_size, epd_quiet_phase_t phase,
    epd_quiet_metrics_t *metrics) {
  if (metrics) memset(metrics, 0, sizeof(*metrics));
  const bool baseline = phase == QUIET_OTP_BASELINE;
  if (phase != QUIET_OTP_BASELINE && phase != QUIET_REFERENCE &&
      phase != QUIET_LONG_PAIR) return ESP_ERR_INVALID_ARG;
  const unsigned y = phase == QUIET_LONG_PAIR ? QUIET_ROW_B : QUIET_ROW_A;
  if (!canvas || !canvas->black || !canvas->red || !metrics || !s_spi ||
      (!baseline && (!previous || previous_size != EPD_CANVAS_BUFFER_SIZE)))
    return ESP_ERR_INVALID_ARG;
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300,
                 "Quiet experiment is only for the known Board1 glass");
  const int64_t start = esp_timer_get_time();
  int64_t phase_start = start;
  esp_err_t err = ESP_OK;
  bool window_entered = false;
  if (baseline) {
    err = epd_panel_wake_and_configure();
  } else {
    const uint8_t boost[] = {0x17, 0x17, 0x17};
    const uint8_t psr = 0x3F; /* Register LUT + BW; keeps scan/power/reset bits. */
    const uint8_t cdi = 0xD7; /* explicitly select OLD/NEW polarity */
    const uint8_t resolution[] = {1, 144, 1, 44};
    uint8_t lut[44];
    epd_hardware_reset();
    err = epd_command_data(0x06, boost, sizeof(boost));
    if (err == ESP_OK) err = epd_command_data(0x00, &psr, 1);
    if (err == ESP_OK) err = epd_command_data(0x50, &cdi, 1);
    if (err == ESP_OK) err = epd_command_data(0x61, resolution, sizeof(resolution));
    for (unsigned table = 0; err == ESP_OK && table < 5; ++table) {
      const size_t size = quiet_make_lut(phase, table, lut);
      err = epd_command_data((uint8_t)(0x20 + table), lut, size);
    }
    if (err == ESP_OK) err = epd_command(0x04);
    if (err == ESP_OK) err = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  }
  metrics->init_ms = quiet_elapsed_ms(phase_start);
  phase_start = esp_timer_get_time();
  if (err == ESP_OK && !baseline) {
    err = epd_command(0x91);
    window_entered = err == ESP_OK;
    const unsigned end_y = y + QUIET_WINDOW_HEIGHT - 1u;
    const uint8_t window[] = {0, 0, 1, 0x8F, (uint8_t)(y >> 8), (uint8_t)y,
        (uint8_t)(end_y >> 8), (uint8_t)end_y, 0};
    if (err == ESP_OK) err = epd_command_data(0x90, window, sizeof(window));
  }
  const size_t offset = baseline ? 0 : y * (BOARD_EPD_WIDTH / 8u);
  const size_t length = baseline ? EPD_CANVAS_BUFFER_SIZE : QUIET_WINDOW_HEIGHT * (BOARD_EPD_WIDTH / 8u);
  if (err == ESP_OK)
    err = epd_command_data(0x10, baseline ? canvas->black : previous + offset, length);
  if (err == ESP_OK)
    err = epd_command_data(0x13, baseline ? canvas->red : canvas->black + offset, length);
  metrics->upload_ms = quiet_elapsed_ms(phase_start);
  if (err == ESP_OK) {
    phase_start = esp_timer_get_time();
    err = epd_command(0x12);
    if (err == ESP_OK) err = quiet_wait_refresh(metrics);
    metrics->refresh_ms = quiet_elapsed_ms(phase_start);
  }
  phase_start = esp_timer_get_time();
  if (window_entered && gpio_get_level(PIN_EPD_BUSY) != 0) {
    const esp_err_t exit_err = epd_command(0x92);
    if (err == ESP_OK) err = exit_err;
  }
  const esp_err_t off_err = baseline ? epd_power_off() : quiet_power_off();
  if (err == ESP_OK) err = off_err;
  metrics->off_ms = quiet_elapsed_ms(phase_start);
  metrics->total_ms = quiet_elapsed_ms(start);
  return err;
}
