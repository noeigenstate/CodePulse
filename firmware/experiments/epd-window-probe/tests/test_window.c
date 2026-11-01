#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include "esp_err.h"
#include "epd_canvas.h"

#define PIN_EPD_BUSY 4
#define EPD_BUSY_TIMEOUT_MS 30000
#define pdMS_TO_TICKS(n) (n)
static void *s_spi = (void *)1;
static int calls, fail_call, off_calls, exit_calls, refresh_calls;
static bool wake_fails, wait_fails, busy, off_fails;
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static esp_err_t epd_panel_wake_and_configure(void) {
  return wake_fails ? ESP_FAIL : ESP_OK;
}
static esp_err_t epd_command(uint8_t command) {
  calls++;
  if (command == 0x12) refresh_calls++;
  if (command == 0x92) { assert(!busy); exit_calls++; }
  return calls == fail_call ? ESP_FAIL : ESP_OK;
}
static esp_err_t epd_command_data(uint8_t command, const uint8_t *p, size_t n) {
  if (command == 0x90) {
    assert(n == 9);
    assert(((unsigned)p[0] * 256 + p[1]) == 0);
    assert(((unsigned)p[2] * 256 + p[3]) == BOARD_EPD_WIDTH - 1);
    assert(((unsigned)p[4] * 256 + p[5]) == 128);
    assert(((unsigned)p[6] * 256 + p[7]) == 167);
    assert(p[8] == 0);
  } else {
    assert(command == 0x10 || command == 0x13);
    const uint8_t *base = command == 0x10 ? black : red;
    assert(p == base + 6400);
    assert(n == 2000 && p + n <= base + sizeof(black));
  }
  return epd_command(command);
}
static int gpio_get_level(int pin) { assert(pin == 4); return !busy; }
static void vTaskDelay(int ticks) { assert(ticks == 100); }
static int64_t esp_timer_get_time(void) { static int64_t t; return t += 1000; }
static esp_err_t epd_wait_refresh_complete(int timeout) {
  assert(timeout == 30000);
  if (wait_fails) { busy = true; return ESP_FAIL; }
  return ESP_OK;
}
static esp_err_t epd_power_off(void) {
  off_calls++;
  return off_fails || busy ? ESP_FAIL : ESP_OK;
}

/* Compile the actual experimental implementation, not a copied algorithm. */
#include "driver_window.inc"

static void reset(void) {
  calls = fail_call = off_calls = exit_calls = refresh_calls = 0;
  wake_fails = wait_fails = busy = off_fails = false;
}
int main(void) {
  epd_canvas_t canvas = {.black = black, .red = red};
  uint32_t duration = 0;
  assert(epd_window_probe_refresh(NULL, &duration) == ESP_ERR_INVALID_ARG);
  assert(off_calls == 0);
  s_spi = NULL;
  assert(epd_window_probe_refresh(&canvas, NULL) == ESP_ERR_INVALID_ARG);
  s_spi = (void *)1;
  reset();
  assert(epd_window_probe_refresh(&canvas, &duration) == ESP_OK);
  assert(duration > 0 && refresh_calls == 1 && off_calls == 1 && exit_calls == 1);
  for (int failure = 1; failure <= 6; ++failure) {
    reset(); fail_call = failure;
    assert(epd_window_probe_refresh(&canvas, NULL) == ESP_FAIL);
    assert(off_calls == 1);
    if (failure <= 4) assert(refresh_calls == 0);
  }
  reset(); wake_fails = true;
  assert(epd_window_probe_refresh(&canvas, NULL) == ESP_FAIL);
  assert(refresh_calls == 0 && off_calls == 1);
  reset(); wait_fails = true;
  assert(epd_window_probe_refresh(&canvas, NULL) == ESP_FAIL);
  assert(exit_calls == 0 && off_calls == 1);
  reset(); off_fails = true;
  assert(epd_window_probe_refresh(&canvas, NULL) == ESP_FAIL);
  assert(off_calls == 1);
  puts("window probe: geometry, bounds, single trigger and failure shutdown checks passed");
}
