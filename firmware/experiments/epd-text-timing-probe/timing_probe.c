#include "timing_probe.h"
#include "timing_sequence.h"
#include <inttypes.h>
#include "board_safety.h"
#include "epd_ssd1683.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "timing_probe";
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t previous[EPD_CANVAS_BUFFER_SIZE];

static void timing_shutdown(void) {
  epd_ssd1683_deep_sleep();
  board_status_led_set(false);
  board_power_release();
  for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}

void codepulse_timing_probe_run(uint32_t short_event, uint32_t long_event) {
  epd_canvas_t canvas = {.black = black, .red = red};
  if (epd_ssd1683_init() != ESP_OK) timing_shutdown();
  timing_probe_state_t state = {0};
  int64_t last_end = 0;
  ESP_LOGW(TAG, "accepted PAIR125 only, four manual A-window text updates, no startup refresh, no Wi-Fi");
  ESP_LOGI(TAG, "CYCLE READY: first short press makes OTP baseline CODEX WAIT 01%%");
  for (;;) {
    uint32_t events = 0;
    if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE) continue;
    if (events & long_event) timing_shutdown();
    if (!(events & short_event)) continue;
    if (state.stopped) {
      ESP_LOGI(TAG, "STOP: bounded sequence finished; no more refreshes");
      continue;
    }
    const int64_t elapsed = esp_timer_get_time() - last_end;
    if (state.next_step != 0 && elapsed < INT64_C(180000000)) {
      ESP_LOGW(TAG, "cooldown: wait %" PRId64 " seconds",
          (INT64_C(180000000) - elapsed + 999999) / 1000000);
      continue;
    }
    const unsigned step = state.next_step;
    ESP_LOGW(TAG, "MANUAL step=%u kind=%s target=%s", step,
        step == 0 ? "OTP_BASELINE" : "PAIR125_A",
        (step & 1u) ? "CODEX RUN 12%" : "CODEX WAIT 01%");
    epd_timing_metrics_t m = {0};
    const esp_err_t result = timing_probe_render_step(&state, &canvas, previous,
        sizeof(previous), &m);
    ESP_LOGI(TAG, "result=%s total=%" PRIu32 " init=%" PRIu32
        " upload=%" PRIu32 " refresh=%" PRIu32 " off=%" PRIu32
        " busy_seen=%u assert=%" PRIu32 " busy_low=%" PRIu32 " ms",
        esp_err_to_name(result), m.total_ms, m.init_ms, m.upload_ms,
        m.refresh_ms, m.off_ms, (unsigned)m.busy_seen, m.busy_assert_ms, m.busy_low_ms);
    if (result != ESP_OK) {
      ESP_LOGE(TAG, "failure: no retry; releasing board power");
      timing_shutdown();
    }
    last_end = esp_timer_get_time();
    if (state.stopped)
      ESP_LOGI(TAG, "DONE: two round trips complete; visual verdict required; no more refreshes");
    else
      ESP_LOGW(TAG, "STOP and inspect readability, ghosting and controls; only if acceptable wait 180s then short press");
    uint32_t queued = 0;
    xTaskNotifyWait(0, UINT32_MAX, &queued, 0);
    if (queued & long_event) timing_shutdown();
  }
}
