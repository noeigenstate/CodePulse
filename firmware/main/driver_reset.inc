/* Shared by the production full/quiet paths and host timing regression. */
static void epd_hardware_reset(void) {
  s_epd_baseline_valid = false;
  gpio_set_level(PIN_EPD_RST, 1);
  vTaskDelay(pdMS_TO_TICKS(200));
  gpio_set_level(PIN_EPD_RST, 0);
  /* At CONFIG_FREERTOS_HZ=100, pdMS_TO_TICKS(5) is zero. A one-tick
   * delay can also return before 5 ms at the tick boundary. Keep the
   * original 5 ms pulse using a microsecond delay, independent of ticks. */
  esp_rom_delay_us(5000);
  gpio_set_level(PIN_EPD_RST, 1);
  vTaskDelay(pdMS_TO_TICKS(200));
}
