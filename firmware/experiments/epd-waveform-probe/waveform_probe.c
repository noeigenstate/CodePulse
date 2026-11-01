#include "waveform_probe.h"
#include <inttypes.h>
#include "board_safety.h"
#include "epd_ssd1683.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "waveform_probe";
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];

static void power_off_board(void) {
  epd_ssd1683_deep_sleep();
  board_status_led_set(false);
  board_power_release();
  for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}

static void draw_pattern(epd_canvas_t *canvas, unsigned phase) {
  epd_canvas_clear(canvas, EPD_COLOR_WHITE);
  const char *states[] = {"ZERO TRY", "HALF TRY"};
  const char *values[] = {"RED 44", "RED 55"};
  epd_canvas_draw_text(canvas, 12, 132, states[phase], 2, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 230, 132, values[phase], 2, EPD_COLOR_RED);
}

void codepulse_waveform_probe_run(uint32_t short_event, uint32_t long_event) {
  epd_canvas_t canvas = {.black = black, .red = red};
  ESP_LOGW(TAG, "PROBE2: LUT before POWER_ON; zero-drive effectiveness test first");
  ESP_LOGI(TAG, "no startup refresh; previous physical image intentionally retained");
  if (epd_ssd1683_init() != ESP_OK) power_off_board();
  unsigned phase = 0;
  int64_t last_end = 0;
  ESP_LOGI(TAG, "READY: short press once for ZERO; no automatic waveforms");
  for (;;) {
    uint32_t events = 0;
    if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE) continue;
    if (events & long_event) power_off_board();
    if (!(events & short_event)) continue;
    if (phase >= 2) {
      ESP_LOGI(TAG, "diagnostic stopped; no further refreshes");
      continue;
    }
    const int64_t elapsed = esp_timer_get_time() - last_end;
    if (phase != 0 && elapsed < INT64_C(180000000)) {
      ESP_LOGW(TAG, "cooldown: wait %" PRId64 " seconds",
                 (INT64_C(180000000) - elapsed + 999999) / 1000000);
      continue;
    }
    const unsigned profile = phase == 0 ? 3 : 2;
    draw_pattern(&canvas, phase);
    uint32_t duration = 0;
    ESP_LOGW(TAG, "MANUAL profile=%u (%s) LUT_before_power=1",
               profile, phase == 0 ? "ZERO effectiveness check" : "HALF repeats");
    const esp_err_t result = epd_waveform_probe_refresh(&canvas, profile, &duration);
    ESP_LOGI(TAG, "profile=%u result=%s duration=%" PRIu32 " ms",
               profile, esp_err_to_name(result), duration);
    if (result != ESP_OK) {
      ESP_LOGE(TAG, "diagnostic error; releasing board power, no retry");
      power_off_board();
    }
    last_end = esp_timer_get_time();
    if (phase == 0 && duration >= 2000) {
      ESP_LOGW(TAG, "ZERO_SLOW: no demonstrated register LUT control; STOP, HALF is disabled");
      phase = 2;
    } else if (phase == 0) {
      ESP_LOGW(TAG, "ZERO_SHORT: inspect unchanged pixels; only after human confirmation and 180s press for HALF");
      phase = 1;
    } else {
      phase = 2;
      ESP_LOGI(TAG, "HALF complete; visual verdict required; no further refreshes");
    }
    uint32_t queued = 0;
    xTaskNotifyWait(0, UINT32_MAX, &queued, 0);
    if (queued & long_event) power_off_board();
  }
}
