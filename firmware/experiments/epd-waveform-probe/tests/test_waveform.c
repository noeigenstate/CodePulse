#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include "esp_err.h"
#include "epd_canvas.h"

#define PIN_EPD_BUSY 4
#define EPD_BUSY_TIMEOUT_MS 30000
#define EPD_INIT_TIMEOUT_MS 5000
#define pdMS_TO_TICKS(n) (n)
static void *s_spi = (void *)1;
static int calls, fail_call, invalid_call, off_calls, exit_calls, refresh_calls, tables;
static bool wake_fails, wait_fails, no_busy_pulse, busy, off_fails;
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static void epd_hardware_reset(void) { }
static esp_err_t epd_wait_ready(int timeout) {
  assert(timeout == 5000 && tables == 4);
  return wake_fails ? ESP_FAIL : ESP_OK;
}
static esp_err_t epd_command(uint8_t command) {
  /* Commands that could program OTP/change voltage/PLL must never appear. */
  assert(command != 0xA0 && command != 0xA1 && command != 0x82 &&
         command != 0x01 && command != 0x30);
  if (command == 0x04) assert(tables == 4);
  calls++;
  if (command == 0x12) refresh_calls++;
  if (command == 0x92) { assert(!busy); exit_calls++; }
  return calls == invalid_call ? ESP_ERR_INVALID_RESPONSE : (calls == fail_call ? ESP_FAIL : ESP_OK);
}
static esp_err_t epd_command_data(uint8_t command, const uint8_t *p, size_t n) {
  if (command == 0x06) {
    assert(n == 3 && p[0] == 0x17 && p[1] == 0x17 && p[2] == 0x17);
  } else if (command == 0x00) {
    assert(n == 1 && p[0] == 0x2F);
  } else if (command == 0x20 || command == 0x22 || command == 0x23 || command == 0x24) {
    assert(n == (command == 0x20 ? 44u : 42u));
    tables++;
  } else if (command == 0x90) {
    assert(n == 9 && p[0] == 0 && p[1] == 0 && p[2] == 1 && p[3] == 0x8F);
    assert(p[4] == 0 && p[5] == 128 && p[6] == 0 && p[7] == 167 && p[8] == 0);
  } else {
    assert(command == 0x10 || command == 0x13);
    const uint8_t *base = command == 0x10 ? black : red;
    assert(p == base + 6400 && n == 2000 && p + n <= base + sizeof(black));
  }
  return epd_command(command);
}
static int gpio_get_level(int pin) { assert(pin == 4); return !busy; }
static void vTaskDelay(int ticks) { assert(ticks == 100); }
static int64_t esp_timer_get_time(void) { static int64_t t; return t += 1000; }
static esp_err_t epd_wait_refresh_complete(int timeout) {
  assert(timeout == 30000);
  if (wait_fails) { busy = true; return ESP_FAIL; }
  if (no_busy_pulse) return ESP_ERR_INVALID_RESPONSE;
  return ESP_OK;
}
static esp_err_t epd_power_off(void) {
  off_calls++;
  return off_fails || busy ? ESP_FAIL : ESP_OK;
}

#include "driver_waveform.inc"

static void reset(void) {
  calls = fail_call = invalid_call = off_calls = exit_calls = refresh_calls = tables = 0;
  wake_fails = wait_fails = no_busy_pulse = busy = off_fails = false;
}
static unsigned frame_units(const uint8_t *data) {
  unsigned sum = 0;
  for (unsigned group = 0; group < 7; ++group)
    sum += (data[group*6+1] + data[group*6+2] + data[group*6+3] + data[group*6+4]) * data[group*6+5];
  return sum;
}
int main(void) {
  uint8_t full[44], reduced[44];
  for (unsigned table = 0; table < 4; ++table) {
    const size_t size = probe_make_lut(table, 1, full);
    assert(probe_make_lut(table, 2, reduced) == size);
    for (size_t i = 0; i < size; ++i) {
      if (i == 11 || i == 17 || i == 23)
        assert(reduced[i] * 2 == full[i]);
      else assert(reduced[i] == full[i]);
    }
    assert(frame_units(full) == 1157 && frame_units(reduced) == 757);
    assert(full[5] == 1 && full[29] == 5 && full[35] == 10 && full[41] == 1);
  }
  assert(probe_make_lut(4, 1, full) == 0);
  assert(probe_make_lut(0, 0, full) == 0);
  for (unsigned table = 0; table < 4; ++table) {
    const size_t size = probe_make_lut(table, 3, full);
    for (size_t i = 0; i < size; ++i) assert(full[i] == 0);
  }
  epd_canvas_t canvas = {.black = black, .red = red};
  assert(epd_waveform_probe_refresh(NULL, 1, NULL) == ESP_ERR_INVALID_ARG);
  assert(epd_waveform_probe_refresh(&canvas, 0, NULL) == ESP_ERR_INVALID_ARG);
  for (unsigned profile = 1; profile <= 2; ++profile) {
    reset();
    assert(epd_waveform_probe_refresh(&canvas, profile, NULL) == ESP_OK);
    assert(tables == 4 && refresh_calls == 1 && exit_calls == 1 && off_calls == 1);
    for (int failure = 1; failure <= 13; ++failure) {
      reset(); fail_call = failure;
      assert(epd_waveform_probe_refresh(&canvas, profile, NULL) == ESP_FAIL);
      assert(off_calls == 1);
      if (failure < 12) assert(refresh_calls == 0);
    }
  }
  reset(); wake_fails = true;
  assert(epd_waveform_probe_refresh(&canvas, 1, NULL) == ESP_FAIL);
  assert(refresh_calls == 0 && off_calls == 1);
  reset(); wait_fails = true;
  assert(epd_waveform_probe_refresh(&canvas, 1, NULL) == ESP_FAIL);
  assert(exit_calls == 0 && off_calls == 1);
  reset(); off_fails = true;
  assert(epd_waveform_probe_refresh(&canvas, 1, NULL) == ESP_FAIL);
  for (int failure = 1; failure <= 13; ++failure) {
    reset(); invalid_call = failure;
    assert(epd_waveform_probe_refresh(&canvas, 3, NULL) == ESP_ERR_INVALID_RESPONSE);
    assert(off_calls == 1);
  }
  reset(); no_busy_pulse = true;
  assert(epd_waveform_probe_refresh(&canvas, 3, NULL) == ESP_OK);
  assert(off_calls == 1);
  for (int failure = 1; failure <= 13; ++failure) {
    reset(); invalid_call = failure;
    assert(epd_waveform_probe_refresh(&canvas, 3, NULL) == ESP_ERR_INVALID_RESPONSE);
    assert(off_calls == 1);
  }
  reset(); no_busy_pulse = true;
  assert(epd_waveform_probe_refresh(&canvas, 2, NULL) == ESP_ERR_INVALID_RESPONSE);
  reset(); wait_fails = true;
  assert(epd_waveform_probe_refresh(&canvas, 3, NULL) == ESP_FAIL);
  puts("PASS: LUT deltas, no voltage/PLL/OTP commands, bounds and failure handling");
}
