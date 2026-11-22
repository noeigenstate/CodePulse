#include "red_probe.h"
#include <inttypes.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static uint8_t old_black[EPD_CANVAS_BUFFER_SIZE], old_red[EPD_CANVAS_BUFFER_SIZE];
static const char *TAG = "red_region_probe";

bool codepulse_red_probe_run(epd_canvas_t *canvas, uint32_t short_event, uint32_t long_event) {
  if (!red_probe_draw(canvas, RED_PROBE_FIRST_FRAME)) return false;
  ESP_LOGW(TAG, "DIAGNOSTIC: manual steps only, no Wi-Fi sync during test; no NVS edits");
  uint32_t duration = 0;
  esp_err_t result = epd_ssd1683_init();
  if (result == ESP_OK) result = epd_ssd1683_refresh(canvas, &duration);
  if (result != ESP_OK) {
    ESP_LOGE(TAG, "baseline failed: %s; no retry", esp_err_to_name(result));
    return false;
  }
  ESP_LOGI(TAG, "frame=%u mode=full-bwr x=0 y=0 w=400 h=300 total=%" PRIu32 " result=ESP_OK", RED_PROBE_FIRST_FRAME, duration);
  unsigned frame = RED_PROBE_FIRST_FRAME;
  int64_t ended = esp_timer_get_time() / 1000;
  for (;;) {
    memcpy(old_black, canvas->black, sizeof(old_black));
    memcpy(old_red, canvas->red, sizeof(old_red));
    uint32_t events = 0;
    (void)xTaskNotifyWait(0, UINT32_MAX, &events, 0);
    if (events & long_event) return false;
    /* Any short presses queued during a waveform are discarded, never replayed. */
    ESP_LOGI(TAG, "frame=%u held; next short press after 180s; long hold powers off", frame);
    for (;;) {
      events = 0;
      if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE) continue;
      if (events & long_event) return false;
      if (!(events & short_event)) continue;
      const int64_t elapsed = esp_timer_get_time() / 1000 - ended;
      if (elapsed < RED_PROBE_COOLDOWN_MS) {
        ESP_LOGW(TAG, "cooldown: wait %" PRId64 "s; early presses not queued",
            (RED_PROBE_COOLDOWN_MS - elapsed + 999) / 1000);
        continue;
      }
      break;
    }
    if (frame == RED_PROBE_LAST_FRAME) {
      ESP_LOGI(TAG, "test ended; returning to normal CodePulse; its first render is a full baseline");
      return true;
    }
    ++frame;
    if (!red_probe_draw(canvas, frame)) return false;
    epd_quiet_metrics_t timing;
#if defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
    const bool bw = false;
    const char *region_mode = "otp-bwr-retained";
#else
    const bool bw = frame >= 3;
    const char *region_mode = "otp-bwr-band";
#endif
    const unsigned y = bw ? RED_PROBE_BW_Y : RED_PROBE_BAND_Y;
    const unsigned height = bw ? RED_PROBE_BW_HEIGHT : RED_PROBE_BAND_HEIGHT;
    if (bw) result = epd_red_probe_bw(canvas, old_black, old_red, sizeof(old_black), y, height, &timing);
    else result = epd_red_probe_region(canvas, old_black, old_red, sizeof(old_black), y, height, &timing);
    ended = esp_timer_get_time() / 1000;
    ESP_LOGI(TAG, "frame=%u mode=%s x=%u y=%u w=%u h=%u total=%" PRIu32
        " refresh=%" PRIu32 " busy=%u result=%s; optical verdict required",
        frame, bw ? "bw-with-static-red" : region_mode, timing.x, y,
        timing.width, height, timing.total_ms, timing.refresh_ms, timing.busy_seen,
        esp_err_to_name(result));
    if (result != ESP_OK) return false; /* Safe shutdown, no fallback or retries. */
  }
}
