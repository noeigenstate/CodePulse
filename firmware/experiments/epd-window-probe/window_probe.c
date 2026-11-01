#include "window_probe.h"
#include <inttypes.h>
#include <stdbool.h>
#include "board_safety.h"
#include "epd_ssd1683.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "window_probe";
static uint8_t black[EPD_CANVAS_BUFFER_SIZE];
static uint8_t red[EPD_CANVAS_BUFFER_SIZE];

static void stop_board(void) {
  epd_ssd1683_deep_sleep();
  board_status_led_set(false);
  board_power_release();
  for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}

static void draw_test(epd_canvas_t *canvas, bool running) {
  epd_canvas_clear(canvas, EPD_COLOR_WHITE);
  epd_canvas_draw_text(canvas, 12, 12, "WINDOW PROBE", 3, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 48, "TOP RED MUST STAY", 2, EPD_COLOR_RED);
  epd_canvas_fill_rect(canvas, 0, 96, 400, 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 0, 124, 400, 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 132, running ? "AGENT RUN" : "AGENT WAIT",
                       2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 238, 154, "STATIC RED", 1, EPD_COLOR_RED);
  epd_canvas_fill_rect(canvas, 0, 170, 400, 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 202, "BOTTOM MUST STAY", 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 12, 242, "RED CONTROL", 3, EPD_COLOR_RED);
  epd_canvas_fill_rect(canvas, 380, 48, 12, 36, EPD_COLOR_RED);
  epd_canvas_fill_rect(canvas, 380, 204, 12, 32, EPD_COLOR_BLACK);
}

void codepulse_window_probe_run(uint32_t short_event, uint32_t long_event) {
  epd_canvas_t canvas = {.black = black, .red = red};
  uint32_t duration = 0;
  ESP_LOGW(TAG, "EXPERIMENT ONLY: no Wi-Fi sync, no custom LUT, no OTP writes");
  draw_test(&canvas, false);
  if (epd_ssd1683_init() != ESP_OK ||
      epd_ssd1683_refresh(&canvas, &duration) != ESP_OK) {
    ESP_LOGE(TAG, "baseline failed; stopping without retries");
    stop_board();
  }
  ESP_LOGI(TAG, "baseline full refresh complete: %" PRIu32 " ms", duration);
  unsigned phase = 0;
  int64_t last_end = esp_timer_get_time();
  ESP_LOGI(TAG, "wait 180 seconds, then short press ONCE for window test");
  for (;;) {
    uint32_t events = 0;
    if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE)
      continue;
    if (events & long_event) stop_board();
    if (!(events & short_event)) continue;
    if (phase >= 2) {
      ESP_LOGI(TAG, "test complete; no further refreshes; long hold shuts down");
      continue;
    }
    const int64_t elapsed = esp_timer_get_time() - last_end;
    if (elapsed < INT64_C(180000000)) {
      ESP_LOGW(TAG, "cooldown: wait %" PRId64 " more seconds",
                 (INT64_C(180000000) - elapsed + 999999) / 1000000);
      continue;
    }
    if (phase == 0) {
      draw_test(&canvas, true);
      ESP_LOGW(TAG, "WINDOW TEST: x=0..399 y=128..167 PT_SCAN=0, OTP BWR");
      const esp_err_t result = epd_window_probe_refresh(&canvas, &duration);
      ESP_LOGI(TAG, "window result=%s duration=%" PRIu32 " ms; visual verdict required",
                 esp_err_to_name(result), duration);
      ESP_LOGI(TAG, "no automatic retry; wait 180s then short press for FULL restore");
      phase = 1;
    } else {
      /* Never repeat failed experiments; only original full-refresh recovery. */
      draw_test(&canvas, false);
      const esp_err_t result = epd_ssd1683_refresh(&canvas, &duration);
      ESP_LOGI(TAG, "full restore result=%s duration=%" PRIu32 " ms",
                 esp_err_to_name(result), duration);
      phase = 2;
    }
    last_end = esp_timer_get_time();
    uint32_t queued = 0;
    xTaskNotifyWait(0, UINT32_MAX, &queued, 0);
    if (queued & long_event) stop_board();
    /* Short presses during a waveform are discarded. */
  }
}
