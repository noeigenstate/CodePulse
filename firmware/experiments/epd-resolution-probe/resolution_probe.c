#include "resolution_probe.h"
#include "resolution_pattern.h"
#include "epd_ssd1683.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

bool codepulse_resolution_probe_run(epd_canvas_t *canvas,
                                   uint32_t short_event, uint32_t long_event) {
  codepulse_resolution_pattern(canvas);
  uint32_t duration = 0;
  esp_err_t error = epd_ssd1683_init();
  if (error == ESP_OK) {
    error = epd_ssd1683_refresh(canvas, &duration);
  }
  if (error != ESP_OK) {
    ESP_LOGE("pixel_probe", "one-shot refresh failed; no retry: %s", esp_err_to_name(error));
    return false;
  }
  ESP_LOGI("pixel_probe", "400x300; 50 bytes/row; 15000 bytes/plane; full=%lu ms",
           (unsigned long)duration);
  uint32_t queued = 0;
  (void)xTaskNotifyWait(0, UINT32_MAX, &queued, 0);
  if (queued & long_event) {
    return false;
  }
  ESP_LOGI("pixel_probe", "image held; short press resumes normal app; long hold powers off");
  for (;;) {
    uint32_t events = 0;
    if (xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY) != pdTRUE) {
      continue;
    }
    if (events & long_event) {
      return false;
    }
    if (events & short_event) {
      return true;
    }
  }
}
