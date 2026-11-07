#include <stdio.h>
#include <string.h>
#include "red_mask_probe.h"
#include "freertos/task.h"
#include "test_check.h"
static uint8_t black[15000], red[15000];
static int64_t clock_ms;
static unsigned init_count, full_count, lut_count, event_index, event_count, fail_lut;
static esp_err_t init_error, full_error;
static bool no_timing_effect;
typedef struct { uint32_t value; int64_t advance; bool drain; } signal_t;
static signal_t signals[24];
void test_log(const char *tag,const char *format,...) { CHECK(tag && format); }
int64_t esp_timer_get_time(void) { return clock_ms*1000; }
int xTaskNotifyWait(uint32_t entry,uint32_t exit,uint32_t *events,TickType_t wait) {
  CHECK(entry==0 && exit==UINT32_MAX && event_index<event_count);
  const signal_t s=signals[event_index++]; CHECK(wait==(s.drain?0:portMAX_DELAY));
  clock_ms+=s.advance; *events=s.value; return pdTRUE;
}
esp_err_t epd_ssd1683_init(void) { ++init_count; return init_error; }
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *c,uint32_t *duration) {
  CHECK(c->black==black && c->red==red); ++full_count;
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  unsigned black_pixels=0;
  for(unsigned y=130;y<158;++y) for(unsigned x=160;x<240;++x) {
    const unsigned i=y*50+x/8,mask=0x80u>>(x%8);
    CHECK(red[i]&mask);black_pixels+=!(black[i]&mask);
  }
  CHECK(black_pixels==328); /* Start from READY, skip accepted ERASE. */
#endif
  *duration=16000; clock_ms+=16000; return full_error;
}
esp_err_t epd_red_mask_refresh(const epd_canvas_t *c,const uint8_t *old,
    const uint8_t *old_red,size_t size,unsigned x,unsigned y,unsigned width,unsigned height,epd_quiet_metrics_t *m) {
  red_mask_plan_t p;
  CHECK(red_mask_prepare(&p,c,old,old_red,size,x,y,width,height)==ESP_OK && x==160 && y==130 && width==80 && height==28);
  ++lut_count; CHECK(lut_count<=2);
  memset(m,0,sizeof(*m)); m->x=160; m->width=80;
  CHECK(p.operation==(RED_MASK_INITIAL_FRAME==0 && lut_count==1?RED_MASK_ERASE:RED_MASK_PAINT));
  m->refresh_ms=no_timing_effect?(p.operation==RED_MASK_ERASE?RED_MASK_ERASE_GATE_MS:RED_MASK_PAINT_GATE_MS):red_mask_nominal_ms(&p);
  m->total_ms=m->refresh_ms+270;
  clock_ms+=m->total_ms; return lut_count==fail_lut?ESP_FAIL:ESP_OK;
}
static void reset(void) {
  clock_ms=0; init_count=full_count=lut_count=event_index=event_count=fail_lut=0;
  init_error=full_error=ESP_OK; no_timing_effect=false;
}
static void push(uint32_t value,int64_t advance,bool drain) {
  CHECK(event_count<24); signals[event_count++]=(signal_t){value,advance,drain};
}
static void sequence(void) {
  for(unsigned frame=RED_MASK_INITIAL_FRAME;frame<=RED_MASK_LAST_FRAME;++frame) {
    push(1,0,true); push(1,179999,false); push(4,0,false); push(1,1,false);
  }
}
static bool run(void) { epd_canvas_t c={.black=black,.red=red}; return codepulse_red_mask_run(&c,1,2); }
int main(void) {
  reset(); sequence(); CHECK(run());
  CHECK(full_count==1 && lut_count==RED_MASK_LAST_FRAME-RED_MASK_INITIAL_FRAME && event_index==event_count);
  reset(); init_error=ESP_FAIL; CHECK(!run() && full_count==0 && event_index==0);
  reset(); full_error=ESP_FAIL; CHECK(!run() && full_count==1 && event_index==0);
  reset(); push(3,0,true); CHECK(!run() && lut_count==0);
  reset(); push(0,0,true); push(3,180000,false); CHECK(!run() && lut_count==0);
  reset(); sequence(); fail_lut=1; CHECK(!run() && lut_count==1 && full_count==1);
#ifndef CODEPULSE_EPD_RED_MASK_COLOR
  reset(); sequence(); fail_lut=2; CHECK(!run() && lut_count==2 && full_count==1);
#endif
  reset(); no_timing_effect=true;
  push(0,0,true);push(1,180000,false);push(1,0,false);push(2,0,false);
  CHECK(!run() && lut_count==1 && full_count==1 && event_index==event_count);
  puts("PASS: configured diagnostic start/steps, manual only, completed-refresh cooldown, queued input discard, long priority, error stops, normal-app return; unchanged timing prevents further exposures");
  return 0;
}
