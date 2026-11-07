#include <stdio.h>
#include <string.h>
#include "red_probe.h"
#include "test_check.h"

static void *s_spi = (void *)1;
static bool s_epd_baseline_valid, busy, wake_fail, wait_fail, off_fail;
static unsigned calls, fail_call, refreshes, exits, off_count, quiet_count;
static esp_err_t quiet_result;
static int64_t clock_us;
static uint8_t black[15000], red[15000], prior_black[15000], prior_red[15000];
static epd_canvas_t canvas = {.black=black,.red=red};
static unsigned expected_y, expected_height;
int64_t esp_timer_get_time(void) { clock_us += 1000; return clock_us; }
static uint32_t quiet_elapsed_ms(int64_t start) { return (uint32_t)((esp_timer_get_time()-start)/1000); }
static int gpio_get_level(int pin) { CHECK(pin == PIN_EPD_BUSY); return !busy; }
static esp_err_t epd_command(uint8_t cmd) {
  ++calls;
  CHECK(cmd == 0x91 || cmd == 0x90 || cmd == 0x10 || cmd == 0x13 || cmd == 0x12 || cmd == 0x92);
  if (cmd == 0x12) ++refreshes;
  if (cmd == 0x92) { CHECK(!busy); ++exits; }
  return calls == fail_call ? ESP_FAIL : ESP_OK;
}
static esp_err_t epd_command_data(uint8_t cmd, const uint8_t *p, size_t n) {
  if (cmd == 0x90) {
    CHECK(n == 9 && p[0] == 0 && p[1] == 0 && p[2] == 1 && p[3] == 143 && p[8] == 0);
    CHECK((unsigned)p[4]*256+p[5] == expected_y);
    CHECK((unsigned)p[6]*256+p[7] == expected_y+expected_height-1);
  } else {
    CHECK(cmd == 0x10 || cmd == 0x13);
    const uint8_t *plane = cmd == 0x10 ? black : red;
    CHECK(p == plane+expected_y*50u && n == expected_height*50u && p+n <= plane+15000);
  }
  return epd_command(cmd);
}
static esp_err_t epd_panel_wake_and_configure(void) { return wake_fail ? ESP_FAIL : ESP_OK; }
static esp_err_t epd_power_off(void) { ++off_count; return off_fail || busy ? ESP_FAIL : ESP_OK; }
static esp_err_t quiet_wait_refresh(epd_quiet_metrics_t *m) {
  m->busy_seen=true; clock_us += 16000000;
  if (wait_fail) { busy=true; return ESP_ERR_TIMEOUT; }
  return ESP_OK;
}
esp_err_t epd_quiet_refresh(const epd_canvas_t *c, const uint8_t *old, size_t n,
    unsigned y, unsigned height, epd_quiet_metrics_t *m) {
  ++quiet_count;
  CHECK(c->black == black && c->red != red && old == prior_black && n == 15000);
  CHECK(y == 198 && height == 40);
  for (unsigned i=0; i<15000; ++i) CHECK(c->red[i] == 255);
  CHECK(!memcmp(red,prior_red,sizeof(red)));
  CHECK(s_epd_baseline_valid);
  m->width=16; m->x=96; m->total_ms=3300;
  s_epd_baseline_valid=quiet_result == ESP_OK;
  return quiet_result;
}
#include "driver_red_probe.inc"

static void reset(unsigned before, unsigned after) {
  CHECK(red_probe_draw(&canvas,before));
  memcpy(prior_black,black,sizeof(black)); memcpy(prior_red,red,sizeof(red));
  CHECK(red_probe_draw(&canvas,after));
  calls=fail_call=refreshes=exits=off_count=quiet_count=0;
  busy=wake_fail=wait_fail=off_fail=false;
  s_epd_baseline_valid=true; s_spi=(void *)1; quiet_result=ESP_OK;
  expected_y=128; expected_height=40;
}
static esp_err_t region(epd_quiet_metrics_t *m) {
  return epd_red_probe_region(&canvas,prior_black,prior_red,15000,128,40,m);
}
static esp_err_t bw(epd_quiet_metrics_t *m) {
  return epd_red_probe_bw(&canvas,prior_black,prior_red,15000,198,40,m);
}
static void ppm(unsigned frame) {
  CHECK(red_probe_draw(&canvas,frame));
  char name[32]; snprintf(name,sizeof(name),"frame-%u.ppm",frame);
  FILE *f=fopen(name,"wb"); CHECK(f); fprintf(f,"P6\n400 300\n255\n");
  for(unsigned bit=0; bit<120000; ++bit) {
    const unsigned mask=0x80u>>(bit%8); unsigned char pixel[3]={255,255,255};
    if(!(red[bit/8]&mask)) { pixel[0]=190; pixel[1]=pixel[2]=30; }
    else if(!(black[bit/8]&mask)) pixel[0]=pixel[1]=pixel[2]=0;
    CHECK(fwrite(pixel,1,3,f)==3);
  }
  CHECK(fclose(f)==0);
}
int main(void) {
  epd_quiet_metrics_t m;
  for(unsigned frame=0;frame<=4;++frame) ppm(frame);
  reset(0,1); CHECK(region(&m)==ESP_OK);
  CHECK(refreshes==1 && off_count==1 && exits==1 && m.width==400 && m.total_ms>=16000 && s_epd_baseline_valid);
  reset(1,2); CHECK(region(&m)==ESP_OK); /* Red removal is a real two-plane change. */
  for(unsigned f=1;f<=6;++f) {
    reset(0,1); fail_call=f; CHECK(region(&m)!=ESP_OK);
    CHECK(off_count==1 && refreshes<=1 && !s_epd_baseline_valid);
    if(f<5) CHECK(refreshes==0);
  }
  reset(0,1); wake_fail=true; CHECK(region(&m)==ESP_FAIL && refreshes==0 && off_count==1);
  reset(0,1); wait_fail=true; CHECK(region(&m)==ESP_ERR_TIMEOUT && exits==0 && off_count==1 && !s_epd_baseline_valid);
  reset(0,1); off_fail=true; CHECK(region(&m)==ESP_FAIL && !s_epd_baseline_valid);
  reset(0,1); s_epd_baseline_valid=false; CHECK(region(&m)==ESP_ERR_INVALID_STATE && calls==0);
  reset(0,1); busy=true; CHECK(region(&m)==ESP_ERR_INVALID_STATE && calls==0 && !s_epd_baseline_valid);
  reset(0,1); s_spi=NULL; CHECK(region(&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); CHECK(region(NULL)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); black[0]^=1; CHECK(region(&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); red[0]^=1; CHECK(region(&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); CHECK(epd_red_probe_region(&canvas,prior_black,prior_red,14999,128,40,&m)==ESP_ERR_INVALID_ARG && calls==0);
  CHECK(epd_red_probe_region(&canvas,black,prior_red,15000,128,40,&m)==ESP_ERR_INVALID_ARG && calls==0);
  CHECK(epd_red_probe_region(&canvas,prior_black,prior_red,15000,299,2,&m)==ESP_ERR_INVALID_ARG && calls==0);
  CHECK(epd_red_probe_region(&canvas,prior_black,prior_red,15000,0,0,&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(2,3); CHECK(bw(&m)==ESP_OK && quiet_count==1 && calls==0);
  reset(3,4); CHECK(bw(&m)==ESP_OK && quiet_count==1);
  reset(2,3); quiet_result=ESP_FAIL; CHECK(bw(&m)==ESP_FAIL && quiet_count==1 && !s_epd_baseline_valid);
  reset(2,3); red[198*50]=prior_red[198*50]=0x7f; CHECK(bw(&m)==ESP_ERR_INVALID_ARG && quiet_count==0);
  reset(2,3); red[0]^=1; CHECK(bw(&m)==ESP_ERR_INVALID_ARG && quiet_count==0);
  reset(2,3); black[0]^=1; CHECK(bw(&m)==ESP_ERR_INVALID_ARG && quiet_count==0);
  reset(2,3); red[10]=black[10]=0; CHECK(bw(&m)==ESP_ERR_INVALID_ARG && quiet_count==0);
  puts("PASS: actual region driver geometry, two planes, safety/fault paths; static-red BW guards; 5 reference frames");
  return 0;
}
