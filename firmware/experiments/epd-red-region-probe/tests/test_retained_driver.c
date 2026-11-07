#include <stdio.h>
#include <string.h>
#include "red_probe.h"
#include "test_check.h"
#define EPD_INIT_TIMEOUT_MS 5000

static void *s_spi = (void *)1;
static bool s_epd_baseline_valid, busy, wake_fail, wait_fail, off_fail, partial_mode;
static unsigned calls, fail_call, refreshes, exits, off_count, upload_count, ready_count;
static int64_t clock_us;
static uint8_t black[15000], red[15000], prior_black[15000], prior_red[15000];
static epd_canvas_t canvas = {.black=black,.red=red};
int64_t esp_timer_get_time(void) { clock_us += 1000; return clock_us; }
static uint32_t quiet_elapsed_ms(int64_t start) { return (uint32_t)((esp_timer_get_time()-start)/1000); }
static int gpio_get_level(int pin) { CHECK(pin == PIN_EPD_BUSY); return !busy; }
static esp_err_t epd_command(uint8_t command) {
  ++calls;
  /* This whitelist excludes RESET, sleep, LUT, PLL, voltage and OTP programming. */
  CHECK(command==0x06 || command==0x00 || command==0x50 || command==0x61 || command==0x04 ||
      command==0x92 || command==0x10 || command==0x13 || command==0x91 || command==0x90 || command==0x12);
  if(command==0x12) { CHECK(partial_mode && upload_count==2 && ready_count==1); ++refreshes; }
  if(command==0x92) { CHECK(!busy); ++exits; }
  if(calls==fail_call) return ESP_FAIL;
  if(command==0x91) partial_mode=true;
  if(command==0x92) partial_mode=false;
  return ESP_OK;
}
static esp_err_t epd_command_data(uint8_t command,const uint8_t *data,size_t size) {
  if(command==0x06) { CHECK(size==3 && data[0]==0x17 && data[1]==0x17 && data[2]==0x17); }
  else if(command==0x00) { CHECK(size==1 && data[0]==0x0f); }
  else if(command==0x50) { CHECK(size==1 && data[0]==0xf7); }
  else if(command==0x61) { const uint8_t expected[]={1,144,1,44}; CHECK(size==4 && !memcmp(data,expected,4)); }
  else if(command==0x90) {
    const uint8_t expected[]={0,0,1,143,0,128,0,167,0};
    CHECK(size==9 && !memcmp(data,expected,9) && partial_mode && upload_count==2);
  } else {
    CHECK(command==0x10 || command==0x13);
    CHECK(!partial_mode && refreshes==0 && size==15000);
    CHECK(data==(command==0x10 ? black : red));
    CHECK(upload_count==(command==0x10 ? 0u : 1u));
    ++upload_count;
  }
  return epd_command(command);
}
static esp_err_t epd_wait_ready(uint32_t timeout) {
  CHECK(timeout==5000 && calls==5); ++ready_count;
  if(wake_fail) { busy=true; return ESP_ERR_TIMEOUT; }
  return ESP_OK;
}
static esp_err_t quiet_wait_refresh(epd_quiet_metrics_t *m) {
  CHECK(refreshes==1 && partial_mode); m->busy_seen=true; clock_us+=16000000;
  if(wait_fail) { busy=true; return ESP_ERR_TIMEOUT; }
  return ESP_OK;
}
static esp_err_t epd_power_off(void) { ++off_count; return off_fail || busy ? ESP_FAIL : ESP_OK; }
#include "driver_red_retained.inc"

static void reset(unsigned before,unsigned after) {
  CHECK(red_probe_draw(&canvas,before));
  memcpy(prior_black,black,sizeof(black)); memcpy(prior_red,red,sizeof(red));
  CHECK(red_probe_draw(&canvas,after));
  calls=fail_call=refreshes=exits=off_count=upload_count=ready_count=0;
  busy=wake_fail=wait_fail=off_fail=partial_mode=false;
  s_epd_baseline_valid=true; s_spi=(void *)1;
}
static esp_err_t update(epd_quiet_metrics_t *m) {
  return epd_red_probe_region(&canvas,prior_black,prior_red,15000,128,40,m);
}
static void ppm(unsigned frame) {
  CHECK(red_probe_draw(&canvas,frame));
  char name[32]; snprintf(name,sizeof(name),"frame-%u.ppm",frame);
  FILE *f=fopen(name,"wb"); CHECK(f); fprintf(f,"P6\n400 300\n255\n");
  for(unsigned bit=0;bit<120000;++bit) {
    const unsigned mask=0x80u>>(bit%8); unsigned char pixel[3]={255,255,255};
    if(!(red[bit/8]&mask)) { pixel[0]=190; pixel[1]=pixel[2]=30; }
    else if(!(black[bit/8]&mask)) pixel[0]=pixel[1]=pixel[2]=0;
    CHECK(fwrite(pixel,1,3,f)==3);
  }
  CHECK(fclose(f)==0);
}
int main(void) {
  epd_quiet_metrics_t m;
  for(unsigned frame=0;frame<=RED_PROBE_LAST_FRAME;++frame) ppm(frame);
  for(unsigned frame=1;frame<=3;++frame) {
    reset(frame-1,frame); CHECK(memcmp(red,prior_red,sizeof(red)));
    CHECK(update(&m)==ESP_OK);
    CHECK(calls==12 && upload_count==2 && refreshes==1 && exits==2 && off_count==1);
    CHECK(m.x==0 && m.width==400 && m.busy_seen && m.total_ms>=16000 && s_epd_baseline_valid);
  }
  for(unsigned fail=1;fail<=12;++fail) {
    reset(0,1); fail_call=fail; CHECK(update(&m)!=ESP_OK);
    CHECK(off_count==1 && refreshes<=1 && !s_epd_baseline_valid);
    if(fail<11) CHECK(refreshes==0);
  }
  reset(0,1); wake_fail=true; CHECK(update(&m)==ESP_ERR_TIMEOUT && refreshes==0 && exits==0 && off_count==1);
  reset(0,1); wait_fail=true; CHECK(update(&m)==ESP_ERR_TIMEOUT && exits==1 && off_count==1 && !s_epd_baseline_valid);
  reset(0,1); off_fail=true; CHECK(update(&m)==ESP_FAIL && !s_epd_baseline_valid);
  reset(0,1); s_epd_baseline_valid=false; CHECK(update(&m)==ESP_ERR_INVALID_STATE && calls==0);
  reset(0,1); busy=true; CHECK(update(&m)==ESP_ERR_INVALID_STATE && calls==0 && !s_epd_baseline_valid);
  reset(0,1); s_spi=NULL; CHECK(update(&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); CHECK(update(NULL)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); black[0]^=1; CHECK(update(&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); red[0]^=1; CHECK(update(&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,0); CHECK(update(&m)==ESP_ERR_INVALID_ARG && calls==0); /* A real red change is required. */
  reset(0,1); CHECK(epd_red_probe_region(&canvas,prior_black,prior_red,14999,128,40,&m)==ESP_ERR_INVALID_ARG && calls==0);
  CHECK(epd_red_probe_region(&canvas,black,prior_red,15000,128,40,&m)==ESP_ERR_INVALID_ARG && calls==0);
  CHECK(epd_red_probe_region(&canvas,prior_black,prior_red,15000,299,2,&m)==ESP_ERR_INVALID_ARG && calls==0);
  CHECK(epd_red_probe_region(&canvas,prior_black,prior_red,15000,0,0,&m)==ESP_ERR_INVALID_ARG && calls==0);
  reset(0,1); red[10]=black[10]=0; CHECK(update(&m)==ESP_ERR_INVALID_ARG && calls==0);
  puts("PASS: actual-red add/move/erase, complete two-plane RAM before regional drive, retained state, failure/busy shutdown");
  return 0;
}
