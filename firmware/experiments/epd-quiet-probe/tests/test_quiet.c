#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "quiet_probe.h"

#define EPD_INIT_TIMEOUT_MS 5000
#define EPD_BUSY_ASSERT_TIMEOUT_MS 1000
#define EPD_BUSY_TIMEOUT_MS 30000
#define pdMS_TO_TICKS(n) (n)
static void *s_spi = (void *)1;
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t prior_frame[EPD_CANVAS_BUFFER_SIZE];
static epd_quiet_phase_t test_phase;
static unsigned test_y;
static bool baseline_test, no_busy, stuck_busy, refreshed;
static int calls, fail_call, tables, refreshes, poweroffs, ready_calls, fail_ready;
static int cs_level, dc_level;
static int64_t now_us, refresh_start;

static int64_t esp_timer_get_time(void) { return now_us; }
static void vTaskDelay(int ticks) { assert(ticks > 0); now_us += (int64_t)ticks * 1000; }
static void epd_hardware_reset(void) { now_us += 405000; }
static esp_err_t epd_panel_wake_and_configure(void) {
  assert(baseline_test); now_us += 455000;
  return ESP_OK;
}
static int gpio_get_level(int pin) {
  assert(pin == PIN_EPD_BUSY);
  if (!refreshed || no_busy) return 1;
  if (stuck_busy) return 0;
  return now_us - refresh_start < 10000 || now_us - refresh_start >= 130000;
}
static void gpio_set_level(int pin, int level) {
  if (pin == PIN_EPD_CS) cs_level = level;
  else { assert(pin == PIN_EPD_DC); dc_level = level; }
}
static esp_err_t epd_command(uint8_t cmd) {
  /* OTP programming, voltage and clock changes are outside the experiment. */
  assert(cmd != 0xA0 && cmd != 0xA1 && cmd != 0x01 && cmd != 0x82 && cmd != 0x30);
  ++calls; now_us += 1000;
  if (calls == fail_call) return ESP_FAIL;
  if (cmd == 0x04) assert(!baseline_test && tables == 5);
  if (cmd == 0x12) { ++refreshes; refreshed = true; refresh_start = now_us; }
  if (cmd == 0x02) { assert(gpio_get_level(PIN_EPD_BUSY)); ++poweroffs; }
  if (cmd == 0x92) assert(gpio_get_level(PIN_EPD_BUSY));
  return ESP_OK;
}
static esp_err_t epd_command_data(uint8_t cmd, const uint8_t *data, size_t size) {
  assert(data && size);
  if (cmd == 0x06) {
    assert(size == 3 && data[0] == 0x17 && data[1] == 0x17 && data[2] == 0x17);
  } else if (cmd == 0x00) {
    assert(size == 1 && data[0] == 0x3F);
  } else if (cmd == 0x50) {
    assert(size == 1 && data[0] == 0xD7); /* OLD/NEW, not new-data-only F7 */
  } else if (cmd == 0x61) {
    assert(size == 4 && data[0] == 1 && data[1] == 144 && data[2] == 1 && data[3] == 44);
  } else if (cmd >= 0x20 && cmd <= 0x24) {
    assert(size == (cmd == 0x20 ? 44u : 42u));
    const uint8_t expected_levels[] = {0, 0x18, 0x5A, 0xA5, 0x24};
    assert(data[0] == expected_levels[cmd - 0x20]);
    assert(data[1] == (test_phase == QUIET_LONG_PAIR ? 50 : 25));
    assert(data[2] == 1 && data[3] == 4 && data[4] == data[1] && data[5] == 1);
    ++tables;
  } else if (cmd == 0x90) {
    const uint8_t expected[] = {0, 0, 1, 143, 0, (uint8_t)test_y, 0, (uint8_t)(test_y + 39), 0};
    assert(size == sizeof(expected) && !memcmp(data, expected, size));
  } else if (cmd == 0x10) {
    assert(data == (baseline_test ? black : prior_frame + test_y * 50u));
    assert(size == (baseline_test ? sizeof(black) : 2000));
    assert(data[0] == (baseline_test ? 0x55 : 0xAA));
  } else {
    assert(cmd == 0x13);
    assert(data == (baseline_test ? red : black + test_y * 50u));
    assert(size == (baseline_test ? sizeof(red) : 2000));
    assert(data[0] == (baseline_test ? 0xFF : 0x55));
  }
  return epd_command(cmd);
}
static esp_err_t epd_wait_ready(uint32_t timeout) {
  assert(timeout == EPD_INIT_TIMEOUT_MS);
  ++ready_calls; now_us += 40000;
  return ready_calls == fail_ready ? ESP_FAIL : ESP_OK;
}
static esp_err_t epd_power_off(void) {
  assert(baseline_test); ++poweroffs; now_us += 50000;
  return ESP_OK;
}

#include "driver_quiet.inc"

static void reset(epd_quiet_phase_t phase) {
  test_phase = phase;
  test_y = phase == QUIET_LONG_PAIR ? 184u : 96u;
  baseline_test = phase == QUIET_OTP_BASELINE;
  no_busy = stuck_busy = refreshed = false;
  calls = fail_call = tables = refreshes = poweroffs = ready_calls = fail_ready = 0;
  cs_level = dc_level = -1;
  now_us = refresh_start = 0;
  s_spi = (void *)1;
  memset(black, 0x55, sizeof(black));
  memset(red, 0xFF, sizeof(red));
  memset(prior_frame, 0xAA, sizeof(prior_frame));
}
int main(void) {
  uint8_t lut[44];
  const uint8_t levels[] = {0, 0x18, 0x5A, 0xA5, 0x24};
  for (unsigned i = 0; i < 5; ++i) {
    assert(quiet_make_lut(QUIET_REFERENCE, i, lut) == (i == 0 ? 44u : 42u));
    assert(lut[0] == levels[i] && lut[1] == 25 && lut[2] == 1 &&
        lut[3] == 4 && lut[4] == 25 && lut[5] == 1);
    assert(lut[6] == 0 && lut[7] == 1 && lut[11] == 1);
    for (unsigned j = 12; j < 44; ++j) assert(lut[j] == 0);
  }
  assert(!quiet_make_lut(QUIET_REFERENCE, 5, lut) && !quiet_make_lut(QUIET_REFERENCE, 0, NULL));
  for (unsigned i = 0; i < 5; ++i) {
    assert(quiet_make_lut(QUIET_LONG_PAIR, i, lut) == (i == 0 ? 44u : 42u));
    assert(lut[0] == levels[i] && lut[1] == 50 && lut[2] == 1 && lut[3] == 4 && lut[4] == 50 && lut[5] == 1);
    assert(lut[6] == 0 && lut[7] == 1 && lut[11] == 1);
    for (unsigned j = 12; j < 44; ++j) assert(lut[j] == 0);
  }
  assert(!quiet_make_lut(QUIET_OTP_BASELINE, 0, lut));
  assert(!quiet_make_lut((epd_quiet_phase_t)99, 0, lut));
  epd_canvas_t canvas = {.black = black, .red = red};
  epd_quiet_metrics_t m;
  reset(QUIET_REFERENCE);
  assert(epd_quiet_probe_refresh(NULL, prior_frame, sizeof(prior_frame), QUIET_REFERENCE, &m) == ESP_ERR_INVALID_ARG);
  assert(epd_quiet_probe_refresh(&canvas, NULL, 0, QUIET_REFERENCE, &m) == ESP_ERR_INVALID_ARG);
  assert(epd_quiet_probe_refresh(&canvas, prior_frame, 2000, QUIET_REFERENCE, &m) == ESP_ERR_INVALID_ARG);
  assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), QUIET_REFERENCE, NULL) == ESP_ERR_INVALID_ARG);
  assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), (epd_quiet_phase_t)99, &m) == ESP_ERR_INVALID_ARG);
  assert(!calls && !refreshes);
  for (int mode = 0; mode < 3; ++mode) {
    const epd_quiet_phase_t phase = (epd_quiet_phase_t)mode;
    const bool baseline = phase == QUIET_OTP_BASELINE;
    reset(phase);
    assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), phase, &m) == ESP_OK);
    assert(m.busy_seen && m.busy_low_ms > 0 && m.refresh_ms >= m.busy_low_ms);
    assert(m.total_ms == m.init_ms + m.upload_ms + m.refresh_ms + m.off_ms);
    assert(refreshes == 1 && poweroffs == 1 && tables == (baseline ? 0 : 5));
    if (!baseline) assert(cs_level == 1 && dc_level == 0);
    const int success_calls = calls;
    for (int failure = 1; failure <= success_calls; ++failure) {
      reset(phase); fail_call = failure;
      assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), phase, &m) == ESP_FAIL);
      if (!baseline) assert(cs_level == 1 && dc_level == 0);
    }
  }
  reset(QUIET_REFERENCE); no_busy = true;
  assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), QUIET_REFERENCE, &m) == ESP_ERR_INVALID_RESPONSE);
  assert(!m.busy_seen && m.refresh_ms >= 1000 && poweroffs == 1);
  reset(QUIET_REFERENCE); stuck_busy = true;
  assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), QUIET_REFERENCE, &m) == ESP_ERR_TIMEOUT);
  assert(m.busy_seen && m.refresh_ms >= 30000 && poweroffs == 0);
  assert(cs_level == 1 && dc_level == 0);
  for (int ready_failure = 1; ready_failure <= 2; ++ready_failure) {
    reset(QUIET_REFERENCE); fail_ready = ready_failure;
    assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), QUIET_REFERENCE, &m) == ESP_FAIL);
    assert(cs_level == 1 && dc_level == 0);
  }
  reset(QUIET_REFERENCE); s_spi = NULL;
  assert(epd_quiet_probe_refresh(&canvas, prior_frame, sizeof(prior_frame), QUIET_REFERENCE, &m) == ESP_ERR_INVALID_ARG);
  assert(!calls);
  puts("PASS: BW OLD/NEW buffers, mode/polarity, independent windows and paired durations, timings, bounded BUSY, failure shutdown");
}
