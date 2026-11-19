#include "red_mask_probe.h"
#include <inttypes.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static uint8_t old_black[EPD_CANVAS_BUFFER_SIZE], old_red[EPD_CANVAS_BUFFER_SIZE];
static const char *TAG = "red_mask_probe";

bool codepulse_red_mask_run(epd_canvas_t *canvas, uint32_t short_event, uint32_t long_event) {
  unsigned frame=RED_MASK_INITIAL_FRAME;
#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
  bool scan_outside_red = false;
  ESP_LOGI(TAG, "scan-ab starts in A; short presses are manual; long powers off");
#endif
  if (!red_mask_draw(canvas, frame)) return false;
  ESP_LOGW(TAG, "DIAGNOSTIC: actual RED changes; no Wi-Fi sync, no NVS writes, manual only");
  uint32_t duration=0;
  esp_err_t result = epd_ssd1683_init();
  if (result == ESP_OK) result = epd_ssd1683_refresh(canvas, &duration);
  if (result != ESP_OK) { ESP_LOGE(TAG, "baseline failed: %s", esp_err_to_name(result)); return false; }
  ESP_LOGI(TAG, "frame=%u mode=otp-baseline total=%" PRIu32 " result=ESP_OK", frame, duration);
  int64_t ended = esp_timer_get_time()/1000;
  for (;;) {
    memcpy(old_black, canvas->black, sizeof(old_black));
    memcpy(old_red, canvas->red, sizeof(old_red));
    uint32_t events=0;
    (void)xTaskNotifyWait(0, UINT32_MAX, &events, 0);
    if (events & long_event) return false;
#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
    if (frame != RED_MASK_LAST_FRAME) {
      ESP_LOGI(TAG, "group=%c READY; short after 180s to test, long powers off",
          scan_outside_red ? 'B' : 'A');
    } else if (scan_outside_red) {
      ESP_LOGI(TAG, "B held; A/B complete; long powers off");
    } else {
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
      ESP_LOGI(TAG, "A held; short after 180s to restore READY for B; long powers off");
#else
      ESP_LOGI(TAG, "A held; only if stripes reproduced, short after 180s to restore READY for B; otherwise power off");
#endif
    }
#else
    ESP_LOGI(TAG, "frame=%u held; optical verdict required; short after 180s, long powers off", frame);
#endif
    for (;;) {
      events=0;
      if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE) continue;
      if (events & long_event) return false;
      if (!(events & short_event)) continue;
      const int64_t elapsed = esp_timer_get_time()/1000-ended;
      if (elapsed < RED_MASK_COOLDOWN_MS) {
        ESP_LOGW(TAG, "cooldown: wait %" PRId64 "s; early presses discarded",
            (RED_MASK_COOLDOWN_MS-elapsed+999)/1000);
        continue;
      }
      break;
    }
    if (frame == RED_MASK_LAST_FRAME) {
#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
      if (scan_outside_red) continue;
      frame = RED_MASK_INITIAL_FRAME;
      if (!red_mask_draw(canvas, frame)) return false;
      result = epd_ssd1683_refresh(canvas, &duration);
      if (result != ESP_OK) {
        ESP_LOGE(TAG, "B baseline failed: %s", esp_err_to_name(result));
        return false;
      }
      ended = esp_timer_get_time() / 1000;
      scan_outside_red = true;
      ESP_LOGI(TAG, "A acknowledged; group=B frame=%u mode=otp-baseline total=%" PRIu32 " result=ESP_OK",
          frame, duration);
      continue;
#else
      ESP_LOGI(TAG, "returning to normal app; first normal render restores OTP baseline");
      return true;
#endif
    }
    ++frame;
    if (!red_mask_draw(canvas, frame)) return false;
    red_mask_plan_t plan;
    if(red_mask_prepare(&plan,canvas,old_black,old_red,sizeof(old_black),
        RED_MASK_X,RED_MASK_Y,RED_MASK_WIDTH,RED_MASK_HEIGHT)!=ESP_OK) return false;
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
    plan.group_b = scan_outside_red;
#endif
    epd_quiet_metrics_t timing;
    ESP_LOGI(TAG, "frame=%u starting BWR_MASK operation=%s LUTS=20,21,22,23,24 CDI=F7 frames=%u nominal_ms=%u hold=%u white=%u black=%u red=%u removed=%u added=%u",
        frame, plan.operation==RED_MASK_ERASE?"ERASE_RED":"DRAW_RED",red_mask_frames(&plan),red_mask_nominal_ms(&plan),
        plan.hold_pixels,plan.white_pixels,plan.black_pixels,plan.red_pixels,plan.red_removed,plan.red_added);
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
    ESP_LOGI(TAG, "group=%c mode=single-pass-r22-r24 PT_SCAN=1",
        scan_outside_red ? 'B' : 'A');
    result = epd_red_mask_refresh_scan_ab(canvas, old_black, old_red, sizeof(old_black),
        RED_MASK_X, RED_MASK_Y, RED_MASK_WIDTH, RED_MASK_HEIGHT, scan_outside_red, &timing);
#elif defined(CODEPULSE_EPD_RED_MASK_SCAN_AB)
    ESP_LOGI(TAG, "group=%c red_PT_SCAN=%u white_PT_SCAN=0",
        scan_outside_red ? 'B' : 'A', (unsigned)scan_outside_red);
    result = epd_red_mask_refresh_scan_ab(canvas, old_black, old_red, sizeof(old_black),
        RED_MASK_X, RED_MASK_Y, RED_MASK_WIDTH, RED_MASK_HEIGHT, scan_outside_red, &timing);
#else
    result = epd_red_mask_refresh(canvas, old_black, old_red, sizeof(old_black),
        RED_MASK_X, RED_MASK_Y, RED_MASK_WIDTH, RED_MASK_HEIGHT, &timing);
#endif
    ended = esp_timer_get_time()/1000;
    ESP_LOGI(TAG, "frame=%u mode=masked-bwr operation=%s x=%u y=%u w=%u h=%u total=%" PRIu32
        " refresh=%" PRIu32 " busy=%u result=%s; optical verdict required",
        frame, frame==1 ? "ERASE_RED" : "DRAW_RED", timing.x, RED_MASK_Y,
        timing.width, RED_MASK_HEIGHT, timing.total_ms, timing.refresh_ms, timing.busy_seen,
        esp_err_to_name(result));
    if (result != ESP_OK) return false;
    if (timing.refresh_ms>=(plan.operation==RED_MASK_ERASE?RED_MASK_ERASE_GATE_MS:RED_MASK_PAINT_GATE_MS)) {
      ESP_LOGE(TAG, "timing gate: masked waveform outside expected duration; further steps disabled; long press powers off");
      for (;;) {
        events=0;
        (void)xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY);
        if (events & long_event) return false;
        if (events & short_event)
          ESP_LOGW(TAG, "no further exposure: timing control not demonstrated");
      }
    }
  }
}
