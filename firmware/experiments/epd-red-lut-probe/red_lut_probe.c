#include "red_lut_probe.h"
#include <inttypes.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static uint8_t old_black[EPD_CANVAS_BUFFER_SIZE], old_red[EPD_CANVAS_BUFFER_SIZE];
static const char *TAG = "red_lut_probe";

bool codepulse_red_lut_run(epd_canvas_t *canvas, uint32_t short_event, uint32_t long_event) {
  if (!red_lut_draw(canvas, 0)) return false;
  ESP_LOGW(TAG, "DIAGNOSTIC: actual RED changes; no Wi-Fi sync, no NVS writes, manual only");
  uint32_t duration=0;
  esp_err_t result = epd_ssd1683_init();
  if (result == ESP_OK) result = epd_ssd1683_refresh(canvas, &duration);
  if (result != ESP_OK) { ESP_LOGE(TAG, "baseline failed: %s", esp_err_to_name(result)); return false; }
  ESP_LOGI(TAG, "frame=0 mode=otp-baseline total=%" PRIu32 " result=ESP_OK", duration);
  unsigned frame=0;
  int64_t ended = esp_timer_get_time()/1000;
  for (;;) {
    memcpy(old_black, canvas->black, sizeof(old_black));
    memcpy(old_red, canvas->red, sizeof(old_red));
    uint32_t events=0;
    (void)xTaskNotifyWait(0, UINT32_MAX, &events, 0);
    if (events & long_event) return false;
    ESP_LOGI(TAG, "frame=%u held; optical verdict required; short after 180s, long powers off", frame);
    for (;;) {
      events=0;
      if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE) continue;
      if (events & long_event) return false;
      if (!(events & short_event)) continue;
      const int64_t elapsed = esp_timer_get_time()/1000-ended;
      if (elapsed < RED_LUT_COOLDOWN_MS) {
        ESP_LOGW(TAG, "cooldown: wait %" PRId64 "s; early presses discarded",
            (RED_LUT_COOLDOWN_MS-elapsed+999)/1000);
        continue;
      }
      break;
    }
    if (frame == RED_LUT_LAST_FRAME) {
      ESP_LOGI(TAG, "returning to normal app; first normal render restores OTP baseline");
      return true;
    }
    ++frame;
    if (!red_lut_draw(canvas, frame)) return false;
    const red_lut_profile_t profile = frame==1 ? RED_LUT_FULL : RED_LUT_SHORT;
    epd_quiet_metrics_t timing;
    ESP_LOGI(TAG, "frame=%u starting REG_BWR profile=%s PLL=3A CDI=F7 frames=%u",
        frame, profile==RED_LUT_FULL ? "FULL" : "SHORT", profile==RED_LUT_FULL ? 1157u : 757u);
    result = epd_red_lut_refresh(canvas, old_black, old_red, sizeof(old_black),
        RED_LUT_BAND_Y, RED_LUT_BAND_HEIGHT, profile, &timing);
    ended = esp_timer_get_time()/1000;
    ESP_LOGI(TAG, "frame=%u mode=register-bwr profile=%s x=%u y=%u w=%u h=%u total=%" PRIu32
        " refresh=%" PRIu32 " busy=%u result=%s; optical verdict required",
        frame, profile==RED_LUT_FULL ? "FULL" : "SHORT", timing.x, RED_LUT_BAND_Y,
        timing.width, RED_LUT_BAND_HEIGHT, timing.total_ms, timing.refresh_ms, timing.busy_seen,
        esp_err_to_name(result));
    if (result != ESP_OK) return false;
  }
}
