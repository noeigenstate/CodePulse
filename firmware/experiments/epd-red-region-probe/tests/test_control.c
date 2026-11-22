#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include "red_probe.h"
#include "freertos/task.h"
#include "test_check.h"

static uint8_t black[15000], red[15000];
static int64_t clock_ms;
static unsigned init_count, full_count, region_count, bw_count, event_index, event_count;
static unsigned fail_region, fail_bw;
static esp_err_t init_error, full_error;
typedef struct { uint32_t value; int64_t advance; bool drain; } signal_t;
static signal_t signals[32];
void test_log(const char *tag, const char *format, ...) { CHECK(tag && format); }
int64_t esp_timer_get_time(void) { return clock_ms*1000; }
int xTaskNotifyWait(uint32_t entry, uint32_t exit, uint32_t *events, TickType_t wait) {
  CHECK(entry==0 && exit==UINT32_MAX && event_index<event_count);
  const signal_t s=signals[event_index++];
  CHECK(wait==(s.drain ? 0 : portMAX_DELAY));
  clock_ms+=s.advance; *events=s.value; return pdTRUE;
}
esp_err_t epd_ssd1683_init(void) { ++init_count; return init_error; }
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *c, uint32_t *duration) {
  CHECK(c->black==black && c->red==red);
  ++full_count; *duration=16000; clock_ms+=16000; return full_error;
}
esp_err_t epd_red_probe_region(const epd_canvas_t *c, const uint8_t *old,
    const uint8_t *old_red, size_t size, unsigned y, unsigned height, epd_quiet_metrics_t *m) {
  CHECK(red_probe_validate(c,old,old_red,size,y,height,false)==ESP_OK);
  CHECK(y==128 && height==40 && memcmp(c->red,old_red,size));
  ++region_count; memset(m,0,sizeof(*m)); m->total_ms=16000; m->width=400;
  clock_ms+=16000; return region_count==fail_region ? ESP_FAIL : ESP_OK;
}
esp_err_t epd_red_probe_bw(const epd_canvas_t *c, const uint8_t *old,
    const uint8_t *old_red, size_t size, unsigned y, unsigned height, epd_quiet_metrics_t *m) {
  CHECK(red_probe_validate(c,old,old_red,size,y,height,true)==ESP_OK);
  CHECK(y==198 && height==40 && memcmp(c->black,old,size) && !memcmp(c->red,old_red,size));
  ++bw_count; memset(m,0,sizeof(*m)); m->total_ms=3300; m->width=16;
  clock_ms+=3300; return bw_count==fail_bw ? ESP_FAIL : ESP_OK;
}
static void reset(void) {
  clock_ms=0; init_count=full_count=region_count=bw_count=event_index=event_count=0;
  fail_region=fail_bw=0; init_error=full_error=ESP_OK;
}
static void push(uint32_t value,int64_t advance,bool drain) {
  CHECK(event_count<32); signals[event_count++]=(signal_t){value,advance,drain};
}
static void sequence(void) {
  for(unsigned frame=RED_PROBE_FIRST_FRAME;frame<=RED_PROBE_LAST_FRAME;++frame) {
    push(1,0,true); /* Short press queued while driving must be discarded. */
    push(1,179999,false); /* One ms too early, even after a 16 s waveform. */
    push(4,0,false); /* Unrelated notification cannot advance. */
    push(1,1,false);
  }
}
static bool run(void) { epd_canvas_t c={.black=black,.red=red}; return codepulse_red_probe_run(&c,1,2); }
int main(void) {
#if defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  const unsigned expected_regions=3, expected_bw=0;
#else
  const unsigned expected_regions = RED_PROBE_FIRST_FRAME == 0 ? 2u : 0u;
  const unsigned expected_bw=2;
#endif
  reset(); sequence(); CHECK(run());
  CHECK(full_count==1 && region_count==expected_regions && bw_count==expected_bw && event_index==event_count);
  reset(); init_error=ESP_FAIL; CHECK(!run() && init_count==1 && full_count==0 && event_index==0);
  reset(); full_error=ESP_FAIL; CHECK(!run() && full_count==1 && event_index==0);
  reset(); push(3,0,true); CHECK(!run() && region_count==0); /* Long wins while busy. */
  reset(); push(0,0,true); push(3,180000,false); CHECK(!run() && region_count==0);
#if !defined(CODEPULSE_EPD_RED_BW_ONLY) || !CODEPULSE_EPD_RED_BW_ONLY
  reset(); sequence(); fail_region=1; CHECK(!run() && full_count==1 && region_count==1 && bw_count==0);
#endif
#if defined(CODEPULSE_EPD_RED_RETAINED) && CODEPULSE_EPD_RED_RETAINED
  reset(); sequence(); fail_region=2; CHECK(!run() && region_count==2 && bw_count==0);
  reset(); sequence(); fail_region=3; CHECK(!run() && region_count==3 && bw_count==0);
#else
  reset(); sequence(); fail_bw=1; CHECK(!run() && full_count==1 && region_count==expected_regions && bw_count==1);
#endif
  puts("PASS: finite manual sequence, completion-based cooldown, queued-input discard, long priority, error shutdown, normal-app return");
  return 0;
}
