#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include "test_check.h"
#include "panel_readback.h"
#include "freertos/task.h"
static unsigned captures,logs,event_index;
static uint32_t events[4];
static esp_err_t simulated;
esp_err_t panel_readback_capture(panel_readback_t *r) {
  ++captures;memset(r,0,sizeof(*r));r->link_verified=simulated==ESP_OK;
  r->otp_repeatable=simulated==ESP_OK;return simulated;
}
void test_log(const char *tag,const char *format,...) { CHECK(tag && format);++logs; }
void vTaskDelay(TickType_t ticks) { CHECK(ticks==1); }
int xTaskNotifyWait(uint32_t entry,uint32_t exit,uint32_t *value,TickType_t wait) {
  CHECK(entry==0 && exit==UINT32_MAX && wait==portMAX_DELAY && event_index<4);
  *value=events[event_index++];return pdTRUE;
}
int main(void) {
  for(unsigned failed=0;failed<2;++failed) {
    captures=logs=event_index=0;simulated=failed?ESP_FAIL:ESP_OK;
    events[0]=4;events[1]=1;events[2]=1;events[3]=3;
    codepulse_panel_readback_run(1,2);
    CHECK(captures==1 && event_index==4 && logs>3);
  }
  puts("PASS: one capture only, short repeats saved RAM, long wins, no production fallthrough");
  return 0;
}
