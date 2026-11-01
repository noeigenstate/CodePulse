#include "quiet_probe.h"
#include "quiet_pattern.h"
#include <inttypes.h>
#include <string.h>
#include "board_safety.h"
#include "epd_ssd1683.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "quiet_probe";
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t previous[EPD_CANVAS_BUFFER_SIZE];

static void quiet_shutdown(void) {
  epd_ssd1683_deep_sleep();
  board_status_led_set(false);
  board_power_release();
  for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}

void codepulse_quiet_probe_run(uint32_t short_event, uint32_t long_event) {
  epd_canvas_t canvas = {.black = black, .red = red};
  if (epd_ssd1683_init() != ESP_OK) quiet_shutdown();
  unsigned phase = 0;
  int64_t last_end = 0;
  ESP_LOGW(TAG, "BW hypothesis, unqualified for BWR glass; no startup refresh");
  ESP_LOGI(TAG, "READY2: first short press makes OTP baseline; A/B cells 3 and 4 black");
  for (;;) {
    uint32_t events = 0;
    if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE) continue;
    if (events & long_event) quiet_shutdown();
    if (!(events & short_event)) continue;
    if (phase >= 3) {
      ESP_LOGI(TAG, "STOP: all three manual stages completed; no more refreshes");
      continue;
    }
    const int64_t elapsed = esp_timer_get_time() - last_end;
    if (phase != 0 && elapsed < INT64_C(180000000)) {
      ESP_LOGW(TAG, "cooldown: wait %" PRId64 " seconds",
          (INT64_C(180000000) - elapsed + 999999) / 1000000);
      continue;
    }
    quiet_draw_pattern(&canvas, (epd_quiet_phase_t)phase);
    ESP_LOGW(TAG, "MANUAL phase=%u kind=%s target=%s", phase,
        phase == 0 ? "OTP_BASELINE" : phase == 1 ? "REFERENCE_25" : "LONG_PAIR_50",
        phase == 0 ? "A/B: BLACK 3+4" : phase == 1 ? "A: BLACK 2+4" : "B: BLACK 2+4");
    epd_quiet_metrics_t m;
    const esp_err_t result = epd_quiet_probe_refresh(&canvas,
        phase == 0 ? NULL : previous, sizeof(previous), (epd_quiet_phase_t)phase, &m);
    ESP_LOGI(TAG, "result=%s total=%" PRIu32 " init=%" PRIu32
        " upload=%" PRIu32 " refresh=%" PRIu32 " off=%" PRIu32
        " busy_seen=%u assert=%" PRIu32 " busy_low=%" PRIu32 " ms",
        esp_err_to_name(result), m.total_ms, m.init_ms, m.upload_ms,
        m.refresh_ms, m.off_ms, (unsigned)m.busy_seen, m.busy_assert_ms, m.busy_low_ms);
    if (result != ESP_OK) {
      ESP_LOGE(TAG, "failure: no retry; releasing board power");
      quiet_shutdown();
    }
    /* Keep the OTP baseline immutable. A and B are disjoint windows, so a
     * failed A result is never treated as the known OLD data for B. Continue
     * to B only after the operator verifies B and outside controls unchanged. */
    if (phase == 0) memcpy(previous, black, sizeof(previous));
    last_end = esp_timer_get_time();
    ++phase;
    if (phase < 3)
      ESP_LOGW(TAG, "STOP and inspect; confirm next row is still clean baseline and outside stable; wait 180s");
    else
      ESP_LOGI(TAG, "DONE: no more refreshes; visual verdict required");
    uint32_t queued = 0;
    xTaskNotifyWait(0, UINT32_MAX, &queued, 0);
    if (queued & long_event) quiet_shutdown();
  }
}
