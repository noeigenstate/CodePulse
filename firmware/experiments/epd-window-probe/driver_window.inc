/* Included inside epd_ssd1683.c only for the isolated probe build. */
#include "window_probe.h"

esp_err_t epd_window_probe_refresh(const epd_canvas_t *canvas,
                                   uint32_t *duration_ms) {
  if (!canvas || !canvas->black || !canvas->red || s_spi == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300,
                 "Window probe is only for the existing Board1 panel");
  const int64_t start = esp_timer_get_time();
  /* 400 columns, rows 128..167 inclusive, gates only inside the window. */
  const uint8_t window[] = {0x00, 0x00, 0x01, 0x8F,
                            0x00, 0x80, 0x00, 0xA7, 0x00};
  const size_t offset = 128 * (BOARD_EPD_WIDTH / 8);
  const size_t bytes = 40 * (BOARD_EPD_WIDTH / 8);
  esp_err_t result = epd_panel_wake_and_configure();
  if (result == ESP_OK) result = epd_command(0x91);
  if (result == ESP_OK)
    result = epd_command_data(0x90, window, sizeof(window));
  if (result == ESP_OK)
    result = epd_command_data(0x10, canvas->black + offset, bytes);
  if (result == ESP_OK)
    result = epd_command_data(0x13, canvas->red + offset, bytes);
  if (result == ESP_OK) result = epd_command(0x12);
  if (result == ESP_OK) {
    vTaskDelay(pdMS_TO_TICKS(100));
    result = epd_wait_refresh_complete(EPD_BUSY_TIMEOUT_MS);
  }
  /* Do not send further window commands while BUSY is asserted. */
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
