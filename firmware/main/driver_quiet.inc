/* PAIR125 integration of the accepted 0.0.8 waveform. Full-width BW windows only. */
#include "epd_quiet.h"
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

esp_err_t epd_quiet_refresh(const epd_canvas_t *canvas,
    const uint8_t *previous, size_t previous_size, unsigned y, unsigned height,
    epd_quiet_metrics_t *metrics) {
  if (metrics) memset(metrics, 0, sizeof(*metrics));
  if (!canvas || !canvas->black || !canvas->red || !metrics || !s_spi ||
      !previous || previous == canvas->black || previous_size != EPD_CANVAS_BUFFER_SIZE ||
      height == 0 || y >= BOARD_EPD_HEIGHT || height > BOARD_EPD_HEIGHT - y)
    return ESP_ERR_INVALID_ARG;
  /* BW mode repurposes the red RAM as NEW. Reject any accidental color use. */
  for (size_t i = 0; i < EPD_CANVAS_BUFFER_SIZE; ++i)
    if (canvas->red[i] != 0xFF) return ESP_ERR_INVALID_ARG;
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300,
                 "PAIR125 is qualified only on the known Board1 prototype");
  /* A valid clean session supplies the panel's existing calibration state.
   * Never recover an unknown/reset/sleeping controller by quietly driving it. */
  if (!s_epd_baseline_valid) return ESP_ERR_INVALID_STATE;
  s_epd_baseline_valid = false;
  if (gpio_get_level(PIN_EPD_BUSY) == 0) return ESP_ERR_INVALID_STATE;
  unsigned first_byte = 0, end_byte = BOARD_EPD_WIDTH / 8u;
#if defined(CODEPULSE_QUIET_RECT_TRIAL) && CODEPULSE_QUIET_RECT_TRIAL
  first_byte = BOARD_EPD_WIDTH / 8u; end_byte = 0;
  for (unsigned row = y; row < y + height; row++)
    for (unsigned col = 0; col < BOARD_EPD_WIDTH / 8u; col++)
      if (previous[row * 50u + col] != canvas->black[row * 50u + col]) {
        if (col < first_byte) first_byte = col;
        if (col + 1 > end_byte) end_byte = col + 1;
      }
  if (!end_byte) { s_epd_baseline_valid = true; return ESP_OK; }
  /* Keep at least two banks: R90 specifies HRED > HRST. */
  if (end_byte - first_byte == 1) {
    if (end_byte < BOARD_EPD_WIDTH / 8u) end_byte++;
    else first_byte--;
  }
#endif
  metrics->x = first_byte * 8u;
  metrics->width = (end_byte - first_byte) * 8u;
  const int64_t start = esp_timer_get_time();
  int64_t phase_start = start;
  esp_err_t err = ESP_OK;
  bool window_entered = false;
  {
    const uint8_t boost[] = {0x17, 0x17, 0x17};
    const uint8_t psr = 0x3F; /* Register LUT + BW; keeps scan/power/reset bits. */
    const uint8_t cdi = 0xD7; /* explicitly select OLD/NEW polarity */
    /* UC8176 R30: reset default 0x3C = 50 Hz; the source GxEPD2_420
     * reference uses 0x3A = 100 Hz. Make frame duration explicit rather
     * than inherit OTP/reset state. PAIR125 LUT frame counts stay identical.
     * Candidate validation: expected prior accepted ~2.63 s, optical QA required. */
    const uint8_t reference_pll = 0x3A;
    const uint8_t resolution[] = {1, 144, 1, 44};
    uint8_t lut[44];
    /* Do not reset between clean baseline and differential updates.
     * A hardware reset also loses panel configuration beyond LUT/PLL.
     * Retain the successful OTP baseline session; refresh still ends in POF.
     * No copied voltage values, OTP writes, extra waveform or cooldown. */
    err = epd_command_data(0x06, boost, sizeof(boost));
    if (err == ESP_OK) err = epd_command_data(0x00, &psr, 1);
    if (err == ESP_OK) err = epd_command_data(0x30, &reference_pll, 1);
    if (err == ESP_OK) err = epd_command_data(0x50, &cdi, 1);
    if (err == ESP_OK) err = epd_command_data(0x61, resolution, sizeof(resolution));
    for (unsigned table = 0; err == ESP_OK && table < 5; ++table) {
      const size_t size = quiet_make_lut(table, lut);
      err = epd_command_data((uint8_t)(0x20 + table), lut, size);
    }
    if (err == ESP_OK) err = epd_command(0x04);
    if (err == ESP_OK) err = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  }
  metrics->init_ms = quiet_elapsed_ms(phase_start);
  phase_start = esp_timer_get_time();
  if (err == ESP_OK) {
    err = epd_command(0x91);
    window_entered = err == ESP_OK;
    const unsigned end_y = y + height - 1u;
    const unsigned end_x = end_byte * 8u - 1u;
    const uint8_t window[] = {(uint8_t)(metrics->x >> 8), (uint8_t)metrics->x,
        (uint8_t)(end_x >> 8), (uint8_t)end_x, (uint8_t)(y >> 8), (uint8_t)y,
        (uint8_t)(end_y >> 8), (uint8_t)end_y, 0};
    if (err == ESP_OK) err = epd_command_data(0x90, window, sizeof(window));
  }
  const size_t offset = y * (BOARD_EPD_WIDTH / 8u);
  const size_t length = height * (BOARD_EPD_WIDTH / 8u);
  if (first_byte == 0 && end_byte == BOARD_EPD_WIDTH / 8u) {
    if (err == ESP_OK) err = epd_command_data(0x10, previous + offset, length);
    if (err == ESP_OK) err = epd_command_data(0x13, canvas->black + offset, length);
  } else {
    /* Upload row slices with the original full-frame stride. Never pretend a
     * cropped rectangle is contiguous in the full OLD/NEW image. */
    if (err == ESP_OK) err = epd_command(0x10);
    for (unsigned row = y; err == ESP_OK && row < y + height; row++)
      err = epd_transmit(previous + row * 50u + first_byte, end_byte - first_byte, 1);
    if (err == ESP_OK) err = epd_command(0x13);
    for (unsigned row = y; err == ESP_OK && row < y + height; row++)
      err = epd_transmit(canvas->black + row * 50u + first_byte, end_byte - first_byte, 1);
  }
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
  const esp_err_t off_err = quiet_power_off();
  if (err == ESP_OK) err = off_err;
  metrics->off_ms = quiet_elapsed_ms(phase_start);
  metrics->total_ms = quiet_elapsed_ms(start);
  s_epd_baseline_valid = err == ESP_OK;
  return err;
}
