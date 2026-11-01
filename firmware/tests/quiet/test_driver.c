#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "epd_quiet.h"
#include "quiet_profile.h"

#define EPD_INIT_TIMEOUT_MS 5000
#define EPD_BUSY_ASSERT_TIMEOUT_MS 1000
#define EPD_BUSY_TIMEOUT_MS 30000
#define pdMS_TO_TICKS(n) ((n) * test_tick_hz / 1000)
static int test_tick_hz = 100;
static void *s_spi = (void *)1;
static bool s_epd_baseline_valid;
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t prior_frame[EPD_CANVAS_BUFFER_SIZE];
static unsigned test_y, test_height, test_x, test_width, stream_row;
static uint8_t stream_command;
static bool no_busy, stuck_busy, refreshed;
static int calls, fail_call, tables, refreshes, poweroffs, ready_calls, fail_ready;
static int cs_level, dc_level;
static int reset_edges, clock_writes;
static int64_t reset_low_at;
static int64_t now_us, refresh_start;

static int64_t esp_timer_get_time(void) { return now_us; }
static void vTaskDelay(int ticks) {
  assert(ticks >= 0);
  if (ticks == 0) return; /* A yield is not a delay. */
  const int64_t tick_us = 1000000 / test_tick_hz;
  now_us = ((now_us / tick_us) + ticks) * tick_us;
}
static void esp_rom_delay_us(uint32_t us) { now_us += us; }

static int gpio_get_level(int pin) {
  assert(pin == PIN_EPD_BUSY);
  if (!refreshed || no_busy) return 1;
  if (stuck_busy) return 0;
  return now_us - refresh_start < 10000 || now_us - refresh_start >= 130000;
}
static void gpio_set_level(int pin, int level) {
  if (pin == PIN_EPD_RST) {
    assert(level == (reset_edges % 3 == 1 ? 0 : 1));
    if (level == 0) reset_low_at = now_us;
    else if (reset_edges % 3 == 2) assert(now_us - reset_low_at >= 5000);
    ++reset_edges;
  }
  else if (pin == PIN_EPD_CS) cs_level = level;
  else { assert(pin == PIN_EPD_DC); dc_level = level; }
}
static esp_err_t epd_command(uint8_t cmd) {
  /* OTP programming and voltage changes remain forbidden. */
  assert(cmd != 0xA0 && cmd != 0xA1 && cmd != 0x01 && cmd != 0x82);
  if (cmd == 0x10 || cmd == 0x13) { stream_command = cmd; stream_row = test_y; }
  ++calls; now_us += 1000;
  if (calls == fail_call) return ESP_FAIL;
  if (cmd == 0x04) assert(tables == 5 && clock_writes == 1);
  if (cmd == 0x12) { ++refreshes; refreshed = true; refresh_start = now_us; }
  if (cmd == 0x02) { assert(gpio_get_level(PIN_EPD_BUSY)); ++poweroffs; }
  if (cmd == 0x92) assert(gpio_get_level(PIN_EPD_BUSY));
  return ESP_OK;
}
static esp_err_t epd_command_data(uint8_t cmd, const uint8_t *data, size_t size) {
  assert(data && size);
  if (cmd == 0x06) {
    assert(size == 3 && data[0] == 0x17 && data[1] == 0x17 && data[2] == 0x17);
  } else if (cmd == 0x00) {
    assert(size == 1 && data[0] == 0x3F);
  } else if (cmd == 0x30) {
    assert(size == 1 && data[0] == 0x3A); /* Only the documented 100 Hz reference. */
    ++clock_writes;
  } else if (cmd == 0x50) {
    assert(size == 1 && data[0] == 0xD7); /* OLD/NEW, not new-data-only F7 */
  } else if (cmd == 0x61) {
    assert(size == 4 && data[0] == 1 && data[1] == 144 && data[2] == 1 && data[3] == 44);
  } else if (cmd >= 0x20 && cmd <= 0x24) {
    assert(size == (cmd == 0x20 ? 44u : 42u));
    const uint8_t expected_levels[] = {0, 0x18, 0x5A, 0xA5, 0x24};
    assert(data[0] == expected_levels[cmd - 0x20]);
    assert(data[1] == EPD_QUIET_PAIR_FRAMES);
    assert(data[2] == 1 && data[3] == 4 && data[4] == data[1] && data[5] == 1);
    ++tables;
  } else if (cmd == 0x90) {
    const unsigned last = test_y + test_height - 1;
    const unsigned end_x = test_x + test_width - 1;
    const uint8_t expected[] = {(uint8_t)(test_x>>8), (uint8_t)test_x,
      (uint8_t)(end_x>>8), (uint8_t)end_x, (uint8_t)(test_y>>8), (uint8_t)test_y,
      (uint8_t)(last>>8), (uint8_t)last, 0};
    assert(size == sizeof(expected) && !memcmp(data, expected, size));
  } else if (cmd == 0x10) {
    assert(data == (prior_frame + test_y * 50u));
    assert(size == (test_height*50u));
    assert(data[0] == 0xAA);
  } else {
    assert(cmd == 0x13);
    assert(data == (black + test_y * 50u));
    assert(size == (test_height*50u));
    assert(data[0] == 0x55);
  }
  return epd_command(cmd);
}
static esp_err_t epd_transmit(const uint8_t *data, size_t size, int dc) {
  assert(dc == 1 && (stream_command == 0x10 || stream_command == 0x13));
  assert(stream_row < test_y + test_height && size == test_width / 8);
  const uint8_t *frame = stream_command == 0x10 ? prior_frame : black;
  assert(data == frame + stream_row * 50u + test_x / 8);
  stream_row++;
  ++calls; now_us += 1000;
  return calls == fail_call ? ESP_FAIL : ESP_OK;
}
static esp_err_t epd_wait_ready(uint32_t timeout) {
  assert(timeout == EPD_INIT_TIMEOUT_MS);
  ++ready_calls; now_us += 40000;
  return ready_calls == fail_ready ? ESP_FAIL : ESP_OK;
}



#include "driver_reset.inc"
#include "driver_quiet.inc"
/* Compare every LUT byte with the archived accepted experiment, not a duplicate table. */
#include "timing_lut.h"
static void reset(unsigned y, unsigned height) {
  test_y=y; test_height=height; test_x=0; test_width=400;
  stream_row=0; stream_command=0; no_busy=stuck_busy=refreshed=false;
  calls=fail_call=tables=refreshes=poweroffs=ready_calls=fail_ready=0;
  reset_edges=clock_writes=0; reset_low_at=-1; s_epd_baseline_valid=true;
  cs_level=dc_level=-1; now_us=refresh_start=0; s_spi=(void*)1;
  memset(black,0x55,sizeof(black)); memset(red,255,sizeof(red)); memset(prior_frame,0xAA,sizeof(prior_frame));
}
int main(void) {
  /* Exercise real production reset at every sub-tick phase, including
   * just before the next tick. The old 5 ms task delay fails at 100 Hz. */
  for (int hz = 100; hz <= 1000; hz *= 10) {
    test_tick_hz = hz;
    for (int phase = 0; phase < 1000000 / hz; ++phase) {
      reset(96, 40);
      now_us = phase;
      epd_hardware_reset();
      assert(reset_edges == 3 && !s_epd_baseline_valid);
      assert(now_us > 390000);
    }
  }
  test_tick_hz = 100;
  puts("PASS: production reset low pulse >= 5 ms at 100/1000 Hz across all tick phases");
  uint8_t accepted[44], actual[44], baseline[44];
  const epd_timing_phase_t expected_phase = EPD_QUIET_PAIR_FRAMES == 150 ? TIMING_PAIR150 : TIMING_PAIR125;
  for(unsigned i=0;i<5;++i) {
    assert(quiet_make_lut(i,actual)==timing_make_lut(expected_phase,i,accepted));
    assert(!memcmp(actual,accepted,sizeof(actual)));
    timing_make_lut(TIMING_PAIR125,i,baseline);
    for (unsigned j=0;j<sizeof(actual);j++)
      assert(actual[j]==((j==1 || j==4) ? EPD_QUIET_PAIR_FRAMES : baseline[j]));
  }
  assert(!quiet_make_lut(5,actual) && !quiet_make_lut(0,NULL));
  epd_canvas_t c={black,red}; epd_quiet_metrics_t m;
  const unsigned windows[][2]={{48,40},{96,40},{156,40},{216,40},{96,160},{48,208},{260,40}};
  for(unsigned i=0;i<sizeof(windows)/sizeof(windows[0]);++i) {
    reset(windows[i][0],windows[i][1]);
    assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),test_y,test_height,&m)==ESP_OK);
    assert(clock_writes==1 && tables==5 && refreshes==1 && poweroffs==1 && m.busy_seen);
    assert(reset_edges==0 && s_epd_baseline_valid);
    assert(cs_level==1 && dc_level==0);
    assert(m.total_ms==m.init_ms+m.upload_ms+m.refresh_ms+m.off_ms);
    const int good_calls=calls;
    for(int fail=1;fail<=good_calls;++fail) {
      reset(windows[i][0],windows[i][1]); fail_call=fail;
      assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),test_y,test_height,&m)==ESP_FAIL);
      assert(cs_level==1 && dc_level==0 && !s_epd_baseline_valid);
      const int stopped_calls=calls;
      assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),test_y,test_height,&m)==ESP_ERR_INVALID_STATE);
      assert(calls==stopped_calls);
    }
  }
  reset(96,40);
  assert(epd_quiet_refresh(NULL,prior_frame,sizeof(prior_frame),96,40,&m)==ESP_ERR_INVALID_ARG);
  assert(epd_quiet_refresh(&c,NULL,0,96,40,&m)==ESP_ERR_INVALID_ARG);
  assert(epd_quiet_refresh(&c,black,sizeof(black),96,40,&m)==ESP_ERR_INVALID_ARG);
  assert(epd_quiet_refresh(&c,prior_frame,2000,96,40,&m)==ESP_ERR_INVALID_ARG);
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),96,40,NULL)==ESP_ERR_INVALID_ARG);
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),300,1,&m)==ESP_ERR_INVALID_ARG);
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),299,2,&m)==ESP_ERR_INVALID_ARG);
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),0,0,&m)==ESP_ERR_INVALID_ARG);
  red[0]=0;
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),96,40,&m)==ESP_ERR_INVALID_ARG);
  assert(!calls);
  reset(96,40); s_epd_baseline_valid=false;
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),96,40,&m)==ESP_ERR_INVALID_STATE);
  assert(!calls);
  reset(96,40); no_busy=true;
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),96,40,&m)==ESP_ERR_INVALID_RESPONSE);
  assert(!m.busy_seen && m.refresh_ms>=1000 && poweroffs==1);
  reset(96,40); stuck_busy=true;
  assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),96,40,&m)==ESP_ERR_TIMEOUT);
  assert(m.busy_seen && m.refresh_ms>=30000 && poweroffs==0);
  for(int fail=1;fail<=2;++fail) {
    reset(96,40); fail_ready=fail;
    assert(epd_quiet_refresh(&c,prior_frame,sizeof(prior_frame),96,40,&m)==ESP_FAIL);
    assert(cs_level==1 && dc_level==0);
  }
#if defined(CODEPULSE_QUIET_RECT_TRIAL) && CODEPULSE_QUIET_RECT_TRIAL
  const unsigned crop[][3] = {{0,0,16},{17,17,16},{49,49,16},{12,22,88},{0,49,400}};
  for (unsigned crop_case = 0; crop_case < sizeof(crop)/sizeof(crop[0]); crop_case++) {
    reset(85,23); memcpy(black, prior_frame, sizeof(black));
    for (unsigned row=85; row<108; row++)
      for (unsigned col=crop[crop_case][0]; col<=crop[crop_case][1]; col++) black[row*50u+col]^=0x5A;
    test_x = crop[crop_case][0]*8u; test_width=crop[crop_case][2];
    if (crop[crop_case][0]==49) test_x=48*8;
    if (test_width==400) { memset(black,0x55,sizeof(black)); }
    epd_quiet_metrics_t narrow;
    assert(epd_quiet_refresh(&(epd_canvas_t){black,red},prior_frame,sizeof(prior_frame),85,23,&narrow)==ESP_OK);
    assert(narrow.x==test_x && narrow.width==test_width && refreshes==1 && poweroffs==1);
    const int transactions=calls;
    for (int fault=1; fault<=transactions; fault++) {
      reset(85,23); memcpy(black,prior_frame,sizeof(black));
      for(unsigned row=85;row<108;row++) for(unsigned col=crop[crop_case][0];col<=crop[crop_case][1];col++) black[row*50u+col]^=0x5A;
      test_x=crop[crop_case][0]*8u;test_width=crop[crop_case][2];if(crop[crop_case][0]==49)test_x=48*8;
      if(test_width==400)memset(black,0x55,sizeof(black));
      fail_call=fault;
      const esp_err_t e=epd_quiet_refresh(&(epd_canvas_t){black,red},prior_frame,sizeof(prior_frame),85,23,&narrow);
      assert(e!=ESP_OK && !s_epd_baseline_valid);
    }
  }
  puts("PASS: narrow byte-aligned windows, both edges, >=16px banks, row strides and every command/row failure");
#endif
  printf("PASS: %s, explicit 100 Hz, archived LUT bytes; only T1/T4 may vary; OLD/NEW, window bounds, one waveform, faults and bounded BUSY\n", EPD_QUIET_PROFILE_NAME);
}
