/* Register-BWR driver candidate, intentionally absent from normal builds.
 * Retain the successful OTP baseline's calibration. Configure after POWER_ON,
 * explicitly choose canvas polarity/clock, then load all BWR tables before DRF.
 * No voltage writes, hard reset, sleep, OTP programming or automatic recovery. */
#include "red_lut5_probe.h"
#include "../epd-waveform-probe/waveform_data.h"

esp_err_t epd_red_lut5_refresh(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned y, unsigned height, red_lut5_profile_t profile, epd_quiet_metrics_t *m) {
  if (m) memset(m, 0, sizeof(*m));
  if (!m || !s_spi || (profile != RED_LUT5_FULL && profile != RED_LUT5_SHORT) ||
      red_lut5_validate(c, old_black, old_red, size, y, height) != ESP_OK)
    return ESP_ERR_INVALID_ARG;
  if (!s_epd_baseline_valid) return ESP_ERR_INVALID_STATE;
  s_epd_baseline_valid = false;
  if (gpio_get_level(PIN_EPD_BUSY) == 0) return ESP_ERR_INVALID_STATE;
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300, "Board1 only");
  const int64_t started = esp_timer_get_time();
  int64_t phase = started;
  bool entered = false;
  m->x = 0; m->width = BOARD_EPD_WIDTH;
  const uint8_t boost[] = {0x17, 0x17, 0x17};
  const uint8_t register_bwr = 0x2f;
  /* UC8176 R50 DDX=11: {red,BW}=11 white, 10 black, 0x red.
   * DDX=01 (the IC default D7, before any panel OTP overrides) reverses red.
   * Do not inherit DDX from reset, OTP or a preceding OLD/NEW BW session. */
  const uint8_t canvas_polarity = 0xf7;
  /* GDEW042Z15 register-BWR reference uses R30=3A (100Hz).
   * Fixed for BOTH profiles. 1157 vs 757 nominal frames is not an optical promise. */
  const uint8_t frame_clock = 0x3a;
  const uint8_t resolution[] = {1, 144, 1, 44};
  esp_err_t result = epd_command_data(0x06, boost, sizeof(boost));
  if (result == ESP_OK) result = epd_command(0x04);
  if (result == ESP_OK) result = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  if (result == ESP_OK) result = epd_command_data(0x00, &register_bwr, 1);
  if (result == ESP_OK) result = epd_command_data(0x30, &frame_clock, 1);
  if (result == ESP_OK) result = epd_command_data(0x50, &canvas_polarity, 1);
  if (result == ESP_OK) result = epd_command_data(0x61, resolution, sizeof(resolution));
  m->init_ms = quiet_elapsed_ms(phase);
  phase = esp_timer_get_time();
  /* Complete RAM planes in full addressing mode; driving is still regional. */
  if (result == ESP_OK) result = epd_command(0x92);
  if (result == ESP_OK) result = epd_command_data(0x10, c->black, size);
  if (result == ESP_OK) result = epd_command_data(0x13, c->red, size);
  uint8_t lut[44];
  /* Cover every sequencer slot, including 0x21. The previous four-table
   * experiment left that slot inherited from OTP. No assumption that an
   * unused pixel selector also makes its timing harmless.
   * Reference WW uses the same white waveform as W. */
  const unsigned reference_table[5] = {0, 2, 1, 2, 3};
  for (unsigned table=0; result==ESP_OK && table<5; ++table) {
    const unsigned source = reference_table[table];
    const size_t length = probe_make_lut(source, (unsigned)profile, lut);
    const uint8_t command = table == 1 ? 0x21 : probe_lut_commands[source];
    result = epd_command_data(command, lut, length);
  }
  if (result == ESP_OK) { result = epd_command(0x91); entered = result == ESP_OK; }
  const unsigned last = y+height-1u;
  const uint8_t window[] = {0, 0, 1, 143, (uint8_t)(y>>8), (uint8_t)y,
      (uint8_t)(last>>8), (uint8_t)last, 0};
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
