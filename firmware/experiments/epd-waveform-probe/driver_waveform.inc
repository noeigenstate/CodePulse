/* Isolated manual experiment: same tri-color mode, volatile LUT registers. */
#include "waveform_probe.h"
#include "waveform_data.h"

esp_err_t epd_waveform_probe_refresh(const epd_canvas_t *canvas, unsigned profile,
                                     uint32_t *duration_ms) {
  if (!canvas || !canvas->black || !canvas->red || !s_spi ||
      (profile < 1 || profile > 3)) return ESP_ERR_INVALID_ARG;
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300,
                 "Probe is only for Board1's 400x300 glass");
  const int64_t start = esp_timer_get_time();
  const uint8_t window[] = {0, 0, 1, 0x8F, 0, 0x80, 0, 0xA7, 0};
  const uint8_t register_bwr = 0x2F; /* Only REG_EN changes from OTP 0x0F. */
  uint8_t lut[44];
  /* Configure volatile LUT BEFORE POWER_ON; do not inherit OTP wake ordering. */
  epd_hardware_reset();
  const uint8_t boost[] = {0x17, 0x17, 0x17};
  esp_err_t result = epd_command_data(0x06, boost, sizeof(boost));
  if (result == ESP_OK)
    result = epd_command_data(0x00, &register_bwr, 1);
  for (unsigned table = 0; result == ESP_OK && table < 4; ++table) {
    const size_t length = probe_make_lut(table, profile, lut);
    result = epd_command_data(probe_lut_commands[table], lut, length);
  }
  if (result == ESP_OK) result = epd_command(0x04);
  if (result == ESP_OK) result = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  if (result == ESP_OK) result = epd_command(0x91);
  if (result == ESP_OK)
    result = epd_command_data(0x90, window, sizeof(window));
  if (result == ESP_OK)
    result = epd_command_data(0x10, canvas->black + 6400, 2000);
  if (result == ESP_OK)
    result = epd_command_data(0x13, canvas->red + 6400, 2000);
  if (result == ESP_OK) result = epd_command(0x12);
  if (result == ESP_OK) {
    vTaskDelay(pdMS_TO_TICKS(100));
    result = epd_wait_refresh_complete(EPD_BUSY_TIMEOUT_MS);
    /* Only accept a missed BUSY pulse after an actually issued ZERO refresh.
     * Command/init failures and a stuck-low timeout remain errors. */
    if (profile == 3 && result == ESP_ERR_INVALID_RESPONSE &&
        gpio_get_level(PIN_EPD_BUSY) != 0) result = ESP_OK;
  }
  if (gpio_get_level(PIN_EPD_BUSY) != 0) {
    const esp_err_t exit_result = epd_command(0x92);
    if (result == ESP_OK) result = exit_result;
  }
  const esp_err_t off_result = epd_power_off();
  if (result == ESP_OK) result = off_result;
  if (duration_ms)
    *duration_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
  return result;
}
