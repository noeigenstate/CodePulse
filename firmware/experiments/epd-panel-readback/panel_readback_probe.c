#include "panel_readback.h"
#include <inttypes.h>
#include <stddef.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
static const char *TAG="panel_readback";
static panel_readback_t snapshot;
static esp_err_t capture_result;
static void report(void) {
  ESP_LOGI(TAG,"result=%s before=%02x partial=%02x after=%02x final=%02x "
               "revision=%02x link=%d repeatable=%d nonuniform=%d revision_match=%d",
    esp_err_to_name(capture_result),snapshot.status_before,snapshot.status_partial,
    snapshot.status_after,snapshot.status_final,snapshot.revision,
    snapshot.link_verified,snapshot.otp_repeatable,snapshot.otp_nonuniform,
    snapshot.revision_matches);
  if(snapshot.link_verified && snapshot.otp_repeatable) {
    ESP_LOGI(TAG,"otp_begin bytes=%u dummy0=%02x dummy1=%02x",
             PANEL_OTP_BYTES,snapshot.dummy[0],snapshot.dummy[1]);
    static const char digits[]="0123456789abcdef";
    for(size_t off=0;off<PANEL_OTP_BYTES;off+=32) {
      char hex[65];
      for(size_t j=0;j<32;++j) {
        const uint8_t b=snapshot.otp[off+j];
        hex[j*2]=digits[b>>4];hex[j*2+1]=digits[b&15];
      }
      hex[64]='\0';
      ESP_LOGI(TAG,"otp %04x %s",(unsigned)off,hex);
      vTaskDelay(1);
    }
    ESP_LOGI(TAG,"otp_end bytes=%u",PANEL_OTP_BYTES);
  }
  ESP_LOGI(TAG,"capture_complete; no display drive; short=repeat saved report, long=power off");
}
void codepulse_panel_readback_run(uint32_t short_bit,uint32_t long_bit) {
  ESP_LOGI(TAG,"read-only diagnostic; existing image stays; SPI driver not initialized");
  capture_result=panel_readback_capture(&snapshot);
  report();
  while(true) {
    uint32_t events=0;
    (void)xTaskNotifyWait(0,UINT32_MAX,&events,portMAX_DELAY);
    if(events&long_bit) return;
    if(events&short_bit) report(); /* Saved RAM only; never re-capture. */
  }
}
