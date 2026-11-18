/* Register-BWR driver candidate, intentionally absent from normal builds.
 * Retain the successful OTP baseline's calibration. Configure after POWER_ON,
 * explicitly choose canvas polarity/clock, then load all BWR tables before DRF.
 * No voltage writes, hard reset, sleep, OTP programming or automatic recovery. */
#include "red_mask_probe.h"

esp_err_t epd_red_mask_refresh(const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height, epd_quiet_metrics_t *m) {
  if (m) memset(m, 0, sizeof(*m));
  red_mask_plan_t plan;
  if (!m || !s_spi ||
      red_mask_prepare(&plan,c,old_black,old_red,size,x,y,width,height) != ESP_OK)
    return ESP_ERR_INVALID_ARG;
  if (!s_epd_baseline_valid) return ESP_ERR_INVALID_STATE;
  s_epd_baseline_valid = false;
  if (gpio_get_level(PIN_EPD_BUSY) == 0) return ESP_ERR_INVALID_STATE;
  _Static_assert(BOARD_EPD_WIDTH == 400 && BOARD_EPD_HEIGHT == 300, "Board1 only");
  const int64_t started = esp_timer_get_time();
  int64_t phase = started;
  bool entered = false;
  m->x = x; m->width = width;
  const uint8_t boost[] = {0x17, 0x17, 0x17};
  const uint8_t register_bwr = 0x2f;
  /* UC8176 R50 DDX=11: {red,BW}=11 white, 10 black, 0x red.
   * DDX=01 (the IC default D7, before any panel OTP overrides) reverses red.
   * Do not inherit DDX from reset, OTP or a preceding OLD/NEW BW session. */
  const uint8_t canvas_polarity = 0xf7;
  /* GDEW042Z15 register-BWR reference uses R30=3A (100Hz).
   * Retained at 100Hz. The profile frame budget is not an optical promise. */
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
  /* Upload two temporary selector planes in full addressing mode.
   * All unchanged pixels, including the same-row controls, select HOLD. */
  if (result == ESP_OK) result = epd_command(0x92);
  uint8_t block[256];
  for(unsigned plane=0; result==ESP_OK && plane<2; ++plane) {
    result=epd_command(plane?0x13:0x10);
    for(size_t offset=0; result==ESP_OK && offset<size; offset+=sizeof(block)) {
      const size_t length=size-offset<sizeof(block)?size-offset:sizeof(block);
      for(size_t i=0;i<length;++i) {
        uint8_t mb,mr;
        red_mask_encode(c->black[offset+i],c->red[offset+i],
            old_black[offset+i],old_red[offset+i],&mb,&mr);
        block[i]=plane?mr:mb;
      }
      result=epd_transmit(block,length,1);
    }
  }
  uint8_t lut[44];
  /* Explicitly replace every slot, including WW, after wake. */
  for (unsigned table=0; result==ESP_OK && table<5; ++table) {
    const size_t length = red_mask_make_lut(table, &plan, lut);
    if (length != (table ? 42u : 44u)) { result = ESP_ERR_INVALID_ARG; break; }
    result = epd_command_data((uint8_t)(0x20u + table), lut, length);
  }
  if (result == ESP_OK) { result = epd_command(0x91); entered = result == ESP_OK; }
  const unsigned last_x=x+width-1u, last_y=y+height-1u;
  /* UC8176 R90: horizontal banks are byte-aligned, PT_SCAN=0 gates only the
   * selected vertical range. Same-row controls test horizontal optical
   * isolation, which cannot be inferred from addressing alone. */
  const uint8_t window[] = {(uint8_t)(x>>8), (uint8_t)x,
      (uint8_t)(last_x>>8), (uint8_t)last_x, (uint8_t)(y>>8), (uint8_t)y,
      (uint8_t)(last_y>>8), (uint8_t)last_y, 0};
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
  /* Masks must not leak into the next renderer. After HV is off, restore
   * canonical two-plane RAM without DRF. Failure invalidates the session;
   * never drive a second recovery refresh automatically. */
  if(result==ESP_OK) result=epd_command_data(0x10,c->black,size);
  if(result==ESP_OK) result=epd_command_data(0x13,c->red,size);
  m->off_ms = quiet_elapsed_ms(phase);
  m->total_ms = quiet_elapsed_ms(started);
  s_epd_baseline_valid = result == ESP_OK;
  return result;
}
