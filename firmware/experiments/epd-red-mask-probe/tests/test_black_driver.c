/* Execute the whole production driver plus the candidate against a bounded
 * SPI/register model. The model checks data/lifecycle, NOT electrophoretics. */
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "test_check.h"
#include "panel_host.h"
#define CODEPULSE_EPD_RED_MASK_PROBE 1
#include "../../../main/epd_ssd1683.c"

static int64_t now_us, busy_until;
static unsigned spi_calls, fail_at, resets, clean_drives, lut_drives, power_offs;
static unsigned failure_lut_drives;
static unsigned power_ons, tables, pll_writes, cdi_writes, pass_index;
static bool slow_clear;
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
static bool slow_white,slow_red_combined;
#endif
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
static bool slow_color;
#endif
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#define TEST_PAINT_PASSES 1u
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
#define TEST_PAINT_PASSES 3u
#else
#define TEST_PAINT_PASSES 2u
#endif
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
#if defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
#define TEST_PAINT_PASS_FRAMES(pass) (expect_scan_outside_red ? 290u : 300u)
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
#define TEST_PAINT_PASS_FRAMES(pass) (expect_scan_outside_red ? 590u : 300u)
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
#define TEST_PAINT_PASS_FRAMES(pass) (expect_scan_outside_red ? 290u : 300u)
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
#define TEST_PAINT_PASS_FRAMES(pass) (expect_scan_outside_red ? 265u : 280u)
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
#define TEST_PAINT_PASS_FRAMES(pass) (expect_scan_outside_red ? 268u : 290u)
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
#define TEST_PAINT_PASS_FRAMES(pass) (expect_scan_outside_red ? 230u : 280u)
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#define TEST_PAINT_PASS_FRAMES(pass) (expect_scan_outside_red ? 380u : 447u)
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
#define TEST_PAINT_PASS_FRAMES(pass) ((pass)==0?122u:((pass)==1?610u:179u))
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
#define TEST_PAINT_PASS_FRAMES(pass) ((pass)==0?854u:179u)
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_FINISH)
#define TEST_PAINT_PASS_FRAMES(pass) ((pass)==0?431u:179u)
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
#define TEST_PAINT_PASS_FRAMES(pass) ((pass)==0?447u:179u)
#else
#define TEST_PAINT_PASS_FRAMES(pass) ((pass)==0?427u:179u)
#endif
#if defined(CODEPULSE_EPD_RED_MASK_RICH_AB) || defined(CODEPULSE_EPD_RED_MASK_FREQ_AB) || defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
#define TEST_PAINT_MIN_MS 3000u
#define TEST_PAINT_MAX_MS 3080u
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
#define TEST_PAINT_MIN_MS 2800u
#define TEST_PAINT_MAX_MS 2880u
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
#define TEST_PAINT_MIN_MS 2900u
#define TEST_PAINT_MAX_MS 2980u
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
#define TEST_PAINT_MIN_MS 2800u
#define TEST_PAINT_MAX_MS 2880u
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#define TEST_PAINT_MIN_MS 4470u
#define TEST_PAINT_MAX_MS 4550u
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL_FINISH)
#define TEST_PAINT_MIN_MS 6100u
#define TEST_PAINT_MAX_MS 6260u
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
#define TEST_PAINT_MIN_MS 6260u
#define TEST_PAINT_MAX_MS 6420u
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
#define TEST_PAINT_MIN_MS 6060u
#define TEST_PAINT_MAX_MS 6300u
#else
#define TEST_PAINT_MIN_MS 6060u
#define TEST_PAINT_MAX_MS 6220u
#endif
#elif defined(CODEPULSE_EPD_RED_MASK_PULSE)
#define TEST_PAINT_PASS_FRAMES(pass) ((pass)==0?179u:306u)
#define TEST_PAINT_MIN_MS 4850u
#define TEST_PAINT_MAX_MS 5010u
#else
#define TEST_PAINT_PASS_FRAMES(pass) 179u
#define TEST_PAINT_MIN_MS 3580u
#define TEST_PAINT_MAX_MS 3740u
#endif
#else
#define TEST_PAINT_PASSES 1u
#define TEST_PAINT_PASS_FRAMES(pass) 434u
#define TEST_PAINT_MIN_MS 4340u
#define TEST_PAINT_MAX_MS 4420u
#endif
static int dc;
static uint8_t cmd, psr, pll, cdi, calibration_marker;
static bool partial, stuck_refresh, no_busy_refresh, stuck_power, stuck_off;
static size_t cursor, uploaded[2], table_lengths[5];
static uint8_t ram[2][15000], luts[5][44];
static uint8_t displayed_black[15000], displayed_red[15000];
static uint8_t black[15000], red[15000], previous_black[15000], previous_red[15000];
static epd_canvas_t canvas={.black=black,.red=red};
#ifdef CODEPULSE_EPD_RED_MASK_GAP_SHIFT
static FILE *spi_trace;
static long red_scan_offset;
#endif
#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
static bool expect_scan_outside_red;
#endif

/* R50 table from UC8176 page20: index is {red,BW}; output LUT command. */
static uint8_t selected_table(uint8_t interval, bool red_bit, bool bw_bit) {
  const uint8_t normal[4]={0x24,0x23,0x22,0x22}; /* DDX01 */
  const uint8_t canvas_encoding[4]={0x22,0x22,0x24,0x23}; /* DDX11 */
  const unsigned i=(red_bit?2u:0u)+(bw_bit?1u:0u);
  CHECK(((interval>>4)&3u)==1u || ((interval>>4)&3u)==3u);
  return ((interval>>4)&3u)==3u ? canvas_encoding[i] : normal[i];
}
static unsigned frames(const uint8_t *data) {
  unsigned sum=0;
  for(unsigned g=0;g<7;++g)
    sum+=(data[g*6+1]+data[g*6+2]+data[g*6+3]+data[g*6+4])*data[g*6+5];
  return sum;
}
int64_t esp_timer_get_time(void) { return now_us; }
void vTaskDelay(int ticks) { now_us+=(int64_t)ticks*10000; }
void esp_rom_delay_us(uint32_t us) { now_us+=us; }
int gpio_get_level(int pin) { CHECK(pin==PIN_EPD_BUSY); return now_us>=busy_until; }
void gpio_set_level(int pin,int level) {
  if(pin==PIN_EPD_DC) dc=level;
  if(pin==PIN_EPD_RST && !level) {
    ++resets; psr=0x0f; pll=0x3c; cdi=0xd7; calibration_marker=0; partial=false;
    memset(ram,255,sizeof(ram));
  }
}
esp_err_t spi_bus_initialize(int host,const spi_bus_config_t *cfg,int dma) {
  CHECK(host==SPI2_HOST && cfg->miso_io_num==-1 && dma==SPI_DMA_CH_AUTO); return ESP_OK;
}
esp_err_t spi_bus_add_device(int host,const spi_device_interface_config_t *cfg,spi_device_handle_t *out) {
  CHECK(host==SPI2_HOST && cfg->clock_speed_hz==2000000); *out=(void *)1; return ESP_OK;
}
esp_err_t spi_bus_free(int host) { CHECK(host==SPI2_HOST); return ESP_OK; }

/* Independent target-transition oracle. This checks command/pixel selection,
 * never simulates pigments or treats an addressed pixel as optically correct. */
static bool paint_intent(void) {
  for(unsigned i=0;i<15000;++i)
    if(previous_red[i] & (uint8_t)~red[i]) return true;
  return false;
}
static bool black_intent(void) {
  for(unsigned i=0;i<15000;++i) {
    const uint8_t changed=(uint8_t)((previous_red[i]^red[i])|(previous_black[i]^black[i]));
    if(changed & red[i] & (uint8_t)~black[i]) return true;
  }
  return false;
}
static void check_candidate_drive(void) {
  CHECK(psr==0x2f && cdi==0xf7 && partial && calibration_marker==0x51);
  CHECK(pll_writes && cdi_writes && tables==5 && uploaded[0]==15000 && uploaded[1]==15000);
  const bool paint=paint_intent();
  const unsigned required=paint?TEST_PAINT_PASSES:(black_intent()?2u:1u);
  const unsigned pass=pass_index++;
  CHECK(pass<required);
  unsigned frame_us=10000;
#if defined(CODEPULSE_EPD_RED_MASK_SPLIT)
  const bool fast=paint && pass==1;
  CHECK(pll==(fast?0x39:0x3a));
  if(fast) frame_us=5000;
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
  const bool fast=paint && pass==0;
  CHECK(pll==(fast?0x39:0x3a));
  if(fast) frame_us=5000;
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB) && !defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  const bool fast=paint && expect_scan_outside_red;
  CHECK(pll==(fast?0x39:0x3a));
  if(fast) frame_us=5000;
#else
  CHECK(pll==0x3a);
#endif
  const unsigned drive_frames=paint?TEST_PAINT_PASS_FRAMES(pass):(pass==0?179u:151u);
  for(unsigned table=0;table<5;++table) {
    uint8_t expected[44]={0};
    if(paint) {
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
      if(pass==0 && table==4) expected[0]=0x80;
      if(pass==1 && table==2) expected[0]=0x40;
      expected[1]=178;
#else
      if(table==2) expected[0]=0xb0;
      if(table==4) expected[0]=0x80;
      expected[1]=178;expected[2]=255;
#endif
    } else {
      if(table==4) expected[0]=pass==0?0x80:0x40;
      expected[1]=pass==0?178:150;
    }
    expected[3]=1;expected[5]=1;
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
    if(paint) {
      memset(expected,0,sizeof(expected));
      if(pass==0) {
        /* Independent complete reference; reduced repeats are explicit. */
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#if defined(CODEPULSE_EPD_RED_MASK_CRISP_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,8},
          {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,50,0,0,0,1},
          {0xc0,36,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xbb,1,4,1,5,3},
          {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,50,0,0,0,1},
          {0xc0,33,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa0,0x88,0x00,0xaa,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_VIVID_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,6},
          {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,56,0,0,0,1},
          {0xc0,40,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,13,13,2,0,1}, {0x90,4,11,1,0,1}, {0xb0,1,4,0,0,8},
          {0xbb,1,4,1,5,5}, {0xbb,1,4,1,5,5}, {0xc0,56,0,0,0,1},
          {0xc0,40,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_SMOOTH_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
          {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,36,0,0,0,1},
          {0xc0,30,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
          {0xb0,1,4,0,0,12}, {0xb0,1,4,0,0,10}, {0xc0,48,0,0,0,1},
          {0xc0,30,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xa0,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
          {0xb0,1,5,0,0,10}, {0xb0,1,5,0,0,8}, {0xb0,1,5,0,0,6},
          {0xc0,54,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
          {0xb0,1,4,0,0,12}, {0xc0,50,0,0,0,1}, {0xc0,50,0,0,0,1},
          {0xc0,28,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0x80,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
          {0xb0,1,4,0,0,12}, {0xb0,1,4,0,0,12}, {0xb0,1,4,0,0,12},
          {0xc0,18,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,28,28,4,0,1}, {0x90,10,12,2,0,1}, {0xb0,1,6,0,0,26},
          {0xb0,1,6,0,0,14}, {0xb0,1,7,0,0,15}, {0xb0,1,7,0,0,9},
          {0xc0,34,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0x8c,3,1,18,2,3},
          {0x8c,3,1,20,2,3}, {0x8c,2,1,20,1,2}, {0x8c,2,1,19,0,2},
          {0xc0,16,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0xa8,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,5,0,0,12},
          {0xb0,1,5,0,0,10}, {0xb0,1,6,0,0,8}, {0xb0,1,6,0,0,6},
          {0xc0,18,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,14,12,2,0,1}, {0x98,2,6,5,1,1}, {0xb0,1,7,0,0,6},
          {0xb0,1,8,0,0,5}, {0xb0,1,9,0,0,5}, {0xb0,1,9,0,0,5},
          {0xc0,45,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa8,0x80,0x00,0xa0,0xa0,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,14,12,2,0,1}, {0x98,2,6,5,1,1}, {0xb0,1,8,0,0,4},
          {0xb0,1,9,0,0,4}, {0xb0,1,10,0,0,4}, {0xb0,1,10,0,0,5},
          {0xc0,48,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa8,0x80,0x00,0xa0,0xa0,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,12,10,2,0,1}, {0x98,2,4,5,1,1}, {0x8c,1,1,6,0,6},
          {0x8c,1,1,7,0,7}, {0x8c,1,1,7,0,6}, {0x8c,1,1,7,0,6},
          {0xc0,35,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa8,0x80,0x00,0xa8,0xa8,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,12,10,2,0,1}, {0x98,2,4,5,1,1}, {0x8c,1,1,6,0,4},
          {0x8c,1,1,7,0,6}, {0x8c,1,1,7,0,6}, {0x8c,1,1,7,0,6},
          {0xc0,38,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0xa8,0x80,0x00,0xa8,0xa8,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
        static const uint8_t single_a[7][6]={
          {0xa0,12,10,2,0,1}, {0x98,2,4,5,1,1}, {0x8c,1,1,6,0,6},
          {0xb0,1,7,0,0,7}, {0xb0,1,9,0,0,4}, {0xb0,1,11,0,0,3},
          {0xc0,64,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0xa8,0x80,0x00,0xa0,0xa0,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,12,12,2,0,1}, {0x8c,1,1,5,0,5}, {0xb0,1,7,0,0,4},
          {0xb0,1,9,0,0,3}, {0xb0,1,11,0,0,2}, {0xb0,1,14,0,0,1},
          {0xc0,68,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0x88,0x00,0xa0,0xa0,0xa0,0x80};
#else
        static const uint8_t single_a[7][6]={
          {0xa0,26,26,10,0,1}, {0x84,14,1,14,1,1}, {0x90,10,10,0,0,1},
          {0xb0,1,4,0,0,30}, {0x8c,1,1,5,0,10}, {0x8c,1,2,5,0,10},
          {0xc0,35,0,0,0,1}
        };
        static const uint8_t white_a[7]={0xa0,0x88,0x80,0x00,0x00,0x88,0x80};
        static const uint8_t single_b[7][6]={
          {0xa0,12,12,4,0,1}, {0x84,8,1,8,1,1}, {0x90,8,6,2,0,1},
          {0x8c,1,1,5,0,16}, {0x8c,1,1,6,0,12}, {0x8c,1,1,7,0,8},
          {0xc0,38,0,0,0,1}
        };
        static const uint8_t white_b[7]={0xa0,0x88,0xa0,0x80,0x00,0x88,0x80};
#endif
        const uint8_t (*const seq)[6]=expect_scan_outside_red?single_b:single_a;
        const uint8_t *const wlevels=expect_scan_outside_red?white_b:white_a;
        for(unsigned g=0;g<7;++g) {
          expected[g*6]=table==2?seq[g][0]:(table==4?wlevels[g]:0);
          memcpy(expected+g*6+1,seq[g]+1,5);
        }
#else
#if defined(CODEPULSE_EPD_RED_MASK_SPLIT)
        const uint8_t red_levels[]={0xa0,0x00,0x84,0x90,0,0,0};
        const uint8_t times[7][5]={{26,26,0,0,1},{10,10,0,0,1},
          {14,1,14,1,1},{10,10,0,0,1},{0},{0},{0}};
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
        const uint8_t red_levels[]={0xa0,0x84,0x90,0xb0,0xb0,0xb0,0xc0};
        const uint8_t times[7][5]={{52,52,40,0,1},{28,2,28,2,1},
          {20,20,0,0,1},{1,4,0,0,40},{1,4,0,0,20},{1,5,0,0,40},{70,0,0,0,1}};
#elif defined(CODEPULSE_EPD_RED_MASK_STAGGER)
        const uint8_t red_levels[]={0xa0,0x00,0x84,0x90,0xbf,0xbf,0xc0};
        const uint8_t times[7][5]={{26,26,0,0,1},{10,10,0,0,1},
          {14,1,14,1,1},{10,10,0,0,1},{1,1,1,2,30},{1,2,1,2,20},{35,0,0,0,1}};
#elif defined(CODEPULSE_EPD_RED_MASK_GAP_SHIFT)
        const uint8_t red_levels[]={0xa0,0x84,0x90,0xb0,0x8c,0x8c,0xc0};
        const uint8_t times[7][5]={{26,26,10,0,1},{14,1,14,1,1},
          {10,10,0,0,1},{1,4,0,0,30},{1,1,5,0,10},{1,2,5,0,10},{35,0,0,0,1}};
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
        const uint8_t red_levels[]={0xa0,0x00,0x84,0x90,0xb0,0x8c,0xc0};
        const uint8_t times[7][5]={{26,26,0,0,1},{10,10,0,0,1},
          {14,1,14,1,1},{10,10,0,0,1},
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_PAIR
          {2,8,0,0,15},
#else
          {1,4,0,0,30},
#endif
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_FINISH
          {1,1,5,0,12},{75,0,0,0,1}};
#else
          {1,1,5,0,20},{35,0,0,0,1}};
#endif
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL100)
        const uint8_t red_levels[]={0xa0,0x00,0x84,0x90,
#ifdef CODEPULSE_EPD_RED_MASK_NEUTRAL
          0x30,0x30,
#else
          0xb0,0xb0,
#endif
          0xc0};
        const uint8_t times[7][5]={{26,26,0,0,1},{10,10,0,0,1},
          {14,1,14,1,1},{10,10,0,0,1},{1,4,0,0,30},{1,5,0,0,20},{35,0,0,0,1}};
#else
        const uint8_t red_levels[]={0xa0,0x00,0x84,0x90,0xb0,0xb0,0xc0};
        const uint8_t times[7][5]={{26,26,0,0,1},{10,10,0,0,1},
          {14,1,14,1,1},{10,10,0,0,1},{4,16,0,0,5},{3,14,0,0,10},{35,0,0,0,1}};
#endif
        for(unsigned g=0;g<7;++g) {
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
          expected[g*6]=(table==2 || table==4)?red_levels[g]:0;
          if(table==4 && (g==4 || g==5)) expected[g*6]=0xfb;
#else
          expected[g*6]=table==2?red_levels[g]:0;
#endif
          memcpy(expected+g*6+1,times[g],5);
        }
#endif
      }
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
      else if(pass==1) {
        const uint8_t levels[]={0xb0,0xb0,0xb0,0xc0};
        const uint8_t times[4][5]={{1,4,0,0,40},{1,4,0,0,20},
          {1,5,0,0,40},{70,0,0,0,1}};
        for(unsigned g=0;g<4;++g) {
          expected[g*6]=table==2?levels[g]:0;
          memcpy(expected+g*6+1,times[g],5);
        }
      }
#endif
      else {
        if(table==4) expected[0]=0x80;
        expected[1]=178;expected[3]=1;expected[5]=1;
      }
    }
#elif defined(CODEPULSE_EPD_RED_MASK_PULSE)
    if(paint && pass==1) {
      /* Independent frozen .39 test oracle, groups 4..6 unchanged.
       * Compare every timing, repeat, trailing byte and inactive selector. */
      static const uint8_t accepted_red_tail[18]={
          0xb0,4,16,0,0,5, 0xb0,3,14,0,0,10, 0xc0,35,0,0,0,1};
      memset(expected,0,sizeof(expected));
      memcpy(expected,accepted_red_tail,sizeof(accepted_red_tail));
      if(table!=2) expected[0]=expected[6]=expected[12]=0;
      expected[19]=1;expected[23]=1;
    }
#endif
    CHECK(table_lengths[table]==(table?42u:44u));
    CHECK(!memcmp(luts[table],expected,table_lengths[table]));
    CHECK(frames(luts[table])==drive_frames);
  }
  unsigned changed=0,held=0,active=0,black_targets=0,red_targets=0;
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
  unsigned red_a=0,red_b=0;
#endif
#if defined(CODEPULSE_EPD_RED_MASK_ACTIVATE) && !defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
  const unsigned white_pass=TEST_PAINT_PASSES-1u;
#endif
  for(unsigned bit=0;bit<120000;++bit) {
    const unsigned i=bit/8,mask=0x80u>>(bit%8);
    const unsigned before=!(previous_red[i]&mask)?2u:(!(previous_black[i]&mask)?1u:0u);
    const unsigned after=!(red[i]&mask)?2u:(!(black[i]&mask)?1u:0u);
    const bool changes=before!=after;
    const bool inside=bit/400>=130 && bit/400<158 && bit%400>=160 && bit%400<240;
    bool local_white_redraw=false;
    uint8_t wanted=0x23;
    if(paint && changes) {
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
      wanted=pass==0?0x24:(after==2?0x22:0x23);
#else
      wanted=after==0?0x24:0x22;
#endif
    }
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
    if(paint) {
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
      local_white_redraw=inside && after==0;
      wanted=changes && after==2?0x22:(local_white_redraw?0x24:0x23);
#else
      local_white_redraw=pass==white_pass && inside && after==0;
      wanted=pass<white_pass && changes && after==2?0x22:(local_white_redraw?0x24:0x23);
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
      if(pass<white_pass && changes && after==2 && inside) {
        wanted=((bit/400u+bit%400u)&1u)?0x24:0x22;
        red_a+=wanted==0x22;red_b+=wanted==0x24;
      }
#endif
#endif
    }
#endif
    if(!paint && changes && (pass==0 || after==1)) wanted=0x24;
    CHECK(selected_table(cdi,(ram[1][i]&mask)!=0,(ram[0][i]&mask)!=0)==wanted);
    if(wanted==0x23) {++held;for(unsigned g=0;g<7;++g) CHECK(luts[3][g*6]==0);}
    else {++active;CHECK(changes || local_white_redraw);}
    if(changes) ++changed;
    if(changes && after==2) ++red_targets;
    if(changes && after==1) {
      ++black_targets;
      CHECK(!paint && wanted==0x24); /* Never R22 for black in either pass. */
    }
    if(!paint && pass==1 && after!=1) CHECK(wanted==0x23);
    if((!changes && !local_white_redraw) || !inside) CHECK(wanted==0x23);
  }
  CHECK(changed && held && active+held==120000);
  if(!paint && pass==0) CHECK(active==changed);
  if(!paint && pass==1) CHECK(active==black_targets && active==328);
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
  if(paint) CHECK(active==2240 && red_targets==1888);
#else
  if(paint && pass<white_pass) CHECK(active==red_targets && active==1888);
  if(paint && pass==white_pass) CHECK(active==352 && red_targets==1888);
#endif
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
  if(paint && pass==0) CHECK(red_a && red_b && red_a+red_b==1888);
#endif
#elif defined(CODEPULSE_EPD_RED_MASK_COLOR)
  if(paint && pass==0) CHECK(active==changed);
  if(paint && pass==1) CHECK(active==red_targets && active==1888);
#else
  CHECK(!paint || red_targets>0);
#endif
  ++lut_drives;
  if(stuck_refresh) busy_until=now_us+60000000;
  else if(no_busy_refresh) busy_until=now_us;
  else if(slow_clear && pass==0)
    busy_until=now_us+(int64_t)(paint?RED_MASK_PAINT_PASS_GATE_MS(pass):3500u)*1000;
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  else if(slow_color && paint && pass==1)
    busy_until=now_us+(int64_t)RED_MASK_PAINT_PASS_GATE_MS(pass)*1000;
#endif
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
  else if(slow_white && paint && pass==2)
    busy_until=now_us+(int64_t)RED_MASK_PAINT_PASS_GATE_MS(pass)*1000;
  else if(slow_red_combined && paint && pass<2)
    busy_until=now_us+(int64_t)drive_frames*frame_us+600000;
#endif
  else busy_until=now_us+(int64_t)drive_frames*frame_us;
}
esp_err_t spi_device_polling_transmit(spi_device_handle_t dev,spi_transaction_t *tx) {
  CHECK(dev && tx->length%8==0); ++spi_calls; now_us+=100;
  if(spi_calls==fail_at) {failure_lut_drives=lut_drives;return ESP_FAIL;}
  const uint8_t *data=tx->tx_buffer;
  const size_t length=tx->length/8;
  CHECK(length<=1024);
#ifdef CODEPULSE_EPD_RED_MASK_GAP_SHIFT
  if (spi_trace != NULL) {
    /* Each record is D/C, two-byte big-endian length, then the SPI payload. */
    const uint8_t header[] = {(uint8_t)dc, (uint8_t)(length >> 8), (uint8_t)length};
    if (dc && cmd == 0x90 && pass_index == 0) {
      const long offset = ftell(spi_trace);
      CHECK(offset >= 0 && length == 9 && red_scan_offset == -1);
      red_scan_offset = offset + (long)sizeof(header) + 8;
    }
    CHECK(fwrite(header, 1, sizeof(header), spi_trace) == sizeof(header));
    CHECK(fwrite(data, 1, length, spi_trace) == length);
  }
#endif
  if(!dc) {
    CHECK(length==1); cmd=data[0]; cursor=0;
    /* Reject voltage, VCOM_DC, OTP programming, and unreviewed commands. */
    CHECK(cmd==0x00 || cmd==0x02 || cmd==0x04 || cmd==0x06 || cmd==0x07 ||
        cmd==0x10 || cmd==0x12 || cmd==0x13 || (cmd>=0x20 && cmd<=0x24) ||
        cmd==0x30 || cmd==0x50 || cmd==0x61 || cmd==0x71 || cmd==0x90 || cmd==0x91 || cmd==0x92);
    if(cmd==0x20) tables=0;
    if(cmd==0x04) {
      ++power_ons; tables=pll_writes=cdi_writes=pass_index=0;
      memset(luts,0xee,sizeof(luts)); /* Adversarial: wake can replace stale LUTs. */
      busy_until=now_us+(stuck_power?60000000:30000);
    }
    if(cmd==0x02) { CHECK(now_us>=busy_until); ++power_offs; busy_until=now_us+(stuck_off?60000000:30000); }
    if(cmd==0x91) { CHECK(now_us>=busy_until); partial=true; }
    if(cmd==0x92) { CHECK(now_us>=busy_until); partial=false; }
    if(cmd==0x10 || cmd==0x13) uploaded[cmd==0x13]=0;
    if(cmd==0x12) {
      if(psr==0x0f) {
        ++clean_drives; calibration_marker=0x51;
        CHECK(!partial && uploaded[0]==15000 && uploaded[1]==15000);
        CHECK(!memcmp(ram[0],black,15000) && !memcmp(ram[1],red,15000));
        busy_until=now_us+130000;
      } else check_candidate_drive();
      if(psr==0x0f || pass_index==(paint_intent()?TEST_PAINT_PASSES:(black_intent()?2u:1u))) {
        memcpy(displayed_black,black,15000); memcpy(displayed_red,red,15000);
      }
    }
    return ESP_OK;
  }
  if(cmd==0x00) { CHECK(length==1); psr=data[0]; }
  else if(cmd==0x30) {
    CHECK(length==1 && now_us>=busy_until);
#if defined(CODEPULSE_EPD_RED_MASK_FAST) || defined(CODEPULSE_EPD_RED_MASK_SPLIT) || (defined(CODEPULSE_EPD_RED_MASK_FREQ_AB) && !defined(CODEPULSE_EPD_RED_MASK_RICH_AB))
    CHECK(data[0]==0x3a || data[0]==0x39);
#else
    CHECK(data[0]==0x3a);
#endif
    pll=data[0];++pll_writes;
  }
  else if(cmd==0x50) { CHECK(length==1); cdi=data[0]; ++cdi_writes; }
  else if(cmd==0x61) { const uint8_t expected[]={1,144,1,44}; CHECK(length==4 && !memcmp(data,expected,4)); }
  else if(cmd==0x90) {
    uint8_t expected[] = {0, 160, 0, 239, 0, 130, 0, 157, 0};
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
    expected[8] = (uint8_t)(paint_intent() && pass_index == 0);
#elif defined(CODEPULSE_EPD_RED_MASK_SCAN_AB)
    expected[8] = (uint8_t)(expect_scan_outside_red && pass_index == 0);
#endif
    CHECK(length==9 && !memcmp(data,expected,9) && partial);
  } else if(cmd==0x10 || cmd==0x13) {
    CHECK(!partial && cursor+length<=15000);
    memcpy(ram[cmd==0x13]+cursor,data,length); cursor+=length; uploaded[cmd==0x13]+=length;
  } else if(cmd>=0x20 && cmd<=0x24) {
    const unsigned table=(unsigned)cmd-0x20u;
    CHECK(table==tables && psr==0x2f && now_us>=busy_until && power_ons);
    CHECK(length==(table?42u:44u)); memcpy(luts[table],data,length); table_lengths[table]=length; ++tables;
  } else if(cmd==0x06) { CHECK(length==3 && data[0]==0x17 && data[1]==0x17 && data[2]==0x17); }
  else if(cmd==0x07) { CHECK(length==1 && data[0]==0xa5); }
  else CHECK(false);
  return ESP_OK;
}

static void cold(void) {
  now_us=busy_until=0; spi_calls=fail_at=resets=clean_drives=lut_drives=power_offs=0;
  failure_lut_drives=0;
  power_ons=tables=pll_writes=cdi_writes=0; dc=0; partial=false;
  stuck_refresh=no_busy_refresh=stuck_power=stuck_off=slow_clear=false;pass_index=0;
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  slow_color=false;
#endif
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
  slow_white=slow_red_combined=false;
#endif
  s_spi=NULL; s_epd_baseline_valid=false;
  CHECK(red_mask_draw(&canvas,0)); CHECK(epd_ssd1683_init()==ESP_OK);
}
static void baseline(void) {
  uint32_t duration=0;
  CHECK(epd_ssd1683_refresh(&canvas,&duration)==ESP_OK);
  CHECK(s_epd_baseline_valid && resets==1 && clean_drives==1 && power_offs==1);
  memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
  CHECK(red_mask_draw(&canvas,1));
}
static esp_err_t update(epd_quiet_metrics_t *m) {
  return epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,160,130,80,28,m);
}
#ifdef CODEPULSE_EPD_RED_MASK_GAP_SHIFT
static long record_shift55_trial(const char *filename, bool scan_outside_red) {
  CHECK(spi_trace == NULL);
  spi_trace = fopen(filename, "wb");
  CHECK(spi_trace != NULL);
  red_scan_offset = -1;
  const unsigned previous_baselines = clean_drives;
  const unsigned previous_drives = lut_drives;
  const unsigned previous_power_offs = power_offs;
  CHECK(red_mask_draw(&canvas, RED_MASK_INITIAL_FRAME));
  uint32_t duration = 0;
  CHECK(epd_ssd1683_refresh(&canvas, &duration) == ESP_OK);
  memcpy(previous_black, black, sizeof(previous_black));
  memcpy(previous_red, red, sizeof(previous_red));
  CHECK(red_mask_draw(&canvas, RED_MASK_LAST_FRAME));

  epd_quiet_metrics_t timing;
#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
  expect_scan_outside_red = scan_outside_red;
  CHECK(epd_red_mask_refresh_scan_ab(&canvas, previous_black, previous_red,
      sizeof(previous_black), 160, 130, 80, 28, scan_outside_red, &timing) == ESP_OK);
  expect_scan_outside_red = false;
#else
  CHECK(!scan_outside_red);
  CHECK(update(&timing) == ESP_OK);
#endif
  CHECK(clean_drives == previous_baselines + 1 && lut_drives == previous_drives + TEST_PAINT_PASSES &&
      power_offs == previous_power_offs + 2);
#if defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  CHECK(timing.refresh_ms >= (scan_outside_red ? 2900u : 3000u) &&
      timing.refresh_ms < (scan_outside_red ? 2980u : 3080u));
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
  CHECK(timing.refresh_ms >= (scan_outside_red ? 2950u : 3000u) &&
      timing.refresh_ms < (scan_outside_red ? 3030u : 3080u));
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
  CHECK(timing.refresh_ms >= (scan_outside_red ? 2900u : 3000u) &&
      timing.refresh_ms < (scan_outside_red ? 2980u : 3080u));
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
  CHECK(timing.refresh_ms >= (scan_outside_red ? 2650u : 2800u) &&
      timing.refresh_ms < (scan_outside_red ? 2730u : 2880u));
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
  CHECK(timing.refresh_ms >= (scan_outside_red ? 2680u : 2900u) &&
      timing.refresh_ms < (scan_outside_red ? 2760u : 2980u));
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
  CHECK(timing.refresh_ms >= (scan_outside_red ? 2300u : 2800u) &&
      timing.refresh_ms < (scan_outside_red ? 2380u : 2880u));
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
  CHECK(timing.refresh_ms >= (scan_outside_red ? 3800u : 4470u) &&
      timing.refresh_ms < (scan_outside_red ? 3880u : 4550u));
#endif
  CHECK(timing.busy_seen && red_scan_offset >= 0 && fclose(spi_trace) == 0);
  spi_trace = NULL;
  return red_scan_offset;
}

#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
static bool read_non_poll_record(FILE *f, uint8_t hdr[3], uint8_t pay[1024],
    unsigned *polls, long *start_offset) {
  for (;;) {
    const long pos = ftell(f);
    CHECK(pos >= 0);
    const size_t n = fread(hdr, 1, 3, f);
    if (n == 0) return false;
    CHECK(n == 3);
    const unsigned rec_len = ((unsigned)hdr[1] << 8) | hdr[2];
    CHECK(rec_len <= 1024 && fread(pay, 1, rec_len, f) == rec_len);
    if (hdr[0] == 0 && rec_len == 1 && pay[0] == 0x71) {
      ++(*polls);
      continue;
    }
    *start_offset = pos;
    return true;
  }
}
#endif

static void check_scan_ab_traces(void) {
  cold();
  const long offset = record_shift55_trial("spi-A.bin", false);
  CHECK(record_shift55_trial("spi-B.bin", true) == offset);
  FILE *a = fopen("spi-A.bin", "rb");
  FILE *b = fopen("spi-B.bin", "rb");
  CHECK(a != NULL && b != NULL);
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
  unsigned lut_diffs = 0, polls_a = 0, polls_b = 0;
  uint8_t last_cmd = 0xff;
  bool verified_scan_bit = false;
#if defined(CODEPULSE_EPD_RED_MASK_FREQ_AB) && !defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  bool verified_pll_diff = false;
#endif
  for (;;) {
    uint8_t hdr_a[3], hdr_b[3], pay_a[1024], pay_b[1024];
    long start_a = 0, start_b = 0;
    const bool has_a = read_non_poll_record(a, hdr_a, pay_a, &polls_a, &start_a);
    const bool has_b = read_non_poll_record(b, hdr_b, pay_b, &polls_b, &start_b);
    CHECK(has_a == has_b);
    if (!has_a) break;
    CHECK(!memcmp(hdr_a, hdr_b, 3));
    const unsigned rec_dc = hdr_a[0];
    const unsigned rec_len = ((unsigned)hdr_a[1] << 8) | hdr_a[2];
    if (!rec_dc) {
      CHECK(rec_len == 1 && pay_a[0] == pay_b[0]);
      last_cmd = pay_a[0];
    } else if (last_cmd >= 0x20 && last_cmd <= 0x24) {
      for (unsigned k = 0; k < rec_len; ++k) {
        if (pay_a[k] != pay_b[k]) ++lut_diffs;
      }
#if defined(CODEPULSE_EPD_RED_MASK_FREQ_AB) && !defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
    } else if (last_cmd == 0x30 && rec_len == 1) {
      CHECK(pay_a[0] == 0x3a && (pay_b[0] == 0x3a || pay_b[0] == 0x39));
      if (pay_b[0] == 0x39) verified_pll_diff = true;
#endif
    } else {
      CHECK(!memcmp(pay_a, pay_b, rec_len));
      if (last_cmd == 0x90 && rec_len == 9) {
        CHECK(start_a == start_b && start_a + 3 + 8 == offset);
        CHECK(pay_a[8] == 1 && pay_b[8] == 1);
        verified_scan_bit = true;
      }
    }
  }
  const long size_a = ftell(a), size_b = ftell(b);
  CHECK(size_a > offset && size_b > offset && polls_a > polls_b && lut_diffs > 0 && verified_scan_bit);
#if defined(CODEPULSE_EPD_RED_MASK_FREQ_AB) && !defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  CHECK(verified_pll_diff);
#endif
  CHECK(!ferror(a) && !ferror(b) && fclose(a) == 0 && fclose(b) == 0);
  printf("PASS: SPI traces A=%ld B=%ld bytes (single-pass); polls=%u/%u; PT_SCAN=1 at offset %ld; A/B differ only in %u LUT bytes\n",
      size_a, size_b, polls_a, polls_b, offset, lut_diffs);
#else
  long index = 0;
  int byte_a;
  while ((byte_a = fgetc(a)) != EOF) {
    const int byte_b = fgetc(b);
    CHECK(byte_b != EOF);
    if (index == offset) {
      CHECK(byte_a == 0 && byte_b == 1);
    } else {
      CHECK(byte_a == byte_b);
    }
    ++index;
  }
  CHECK(index > offset && fgetc(b) == EOF && !ferror(a) && !ferror(b));
  CHECK(fclose(a) == 0 && fclose(b) == 0);
  printf("PASS: %ld SPI trace bytes; only red R90 data byte 9 changes 00->01 at offset %ld\n",
      index, offset);
#endif
}
#endif
#endif

static void ppm(unsigned frame) {
  CHECK(red_mask_draw(&canvas,frame)); char name[32]; snprintf(name,sizeof(name),"frame-%u.ppm",frame);
  FILE *f=fopen(name,"wb"); CHECK(f); fprintf(f,"P6\n400 300\n255\n");
  for(unsigned bit=0;bit<120000;++bit) {
    const unsigned mask=0x80u>>(bit%8); unsigned char p[3]={255,255,255};
    if(!(red[bit/8]&mask)) { p[0]=190; p[1]=p[2]=30; }
    else if(!(black[bit/8]&mask)) p[0]=p[1]=p[2]=0;
    CHECK(fwrite(p,1,3,f)==3);
  }
  CHECK(fclose(f)==0);
}
static esp_err_t validate(const epd_canvas_t *c,const uint8_t *ob,const uint8_t *or_,
    size_t size,unsigned x,unsigned y,unsigned w,unsigned h) {
  red_mask_plan_t p; return red_mask_prepare(&p,c,ob,or_,size,x,y,w,h);
}
static void transitions(void) {
  cold(); memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
  for(unsigned step=1;step<=2;++step) {
    CHECK(red_mask_draw(&canvas,step)); unsigned counts[3][3]={{0}};
    CHECK(validate(&canvas,previous_black,previous_red,15000,160,130,80,28)==ESP_OK);
    for(unsigned bit=0;bit<120000;++bit) {
      const unsigned i=bit/8, mask=0x80u>>(bit%8);
      const unsigned before=!(previous_red[i]&mask)?2u:(!(previous_black[i]&mask)?1u:0u);
      const unsigned after=!(red[i]&mask)?2u:(!(black[i]&mask)?1u:0u);
      ++counts[before][after];
    }
    if (step==1) {
      CHECK(counts[2][0] && counts[2][1] && !counts[0][2] && !counts[1][2]);
      for(unsigned y=130;y<158;++y)
        for(unsigned col=20;col<30;++col) CHECK(red[y*50+col]==255);
    } else CHECK(counts[0][2] && counts[1][2] && !counts[2][0] && !counts[2][1]);
    memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
  }
}
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
static unsigned expand_5ms(const uint8_t *lut,unsigned hz,uint8_t *out,unsigned capacity) {
  CHECK(hz==100 || hz==200);
  unsigned count=0;
  for(unsigned group=0;group<7;++group)
    for(unsigned repeat=0;repeat<lut[group*6+5];++repeat)
      for(unsigned phase=0;phase<4;++phase)
        for(unsigned tick=0;tick<lut[group*6+1+phase]*(200u/hz);++tick) {
          CHECK(count<capacity);
          out[count++]=(uint8_t)((lut[group*6]>>(6u-2u*phase))&3u);
        }
  return count;
}
static void check_split_reference(void) {
  const uint8_t fast47[42]={
      0xa0,52,52,40,0,1, 0x84,28,2,28,2,1, 0x90,20,20,0,0,1,
      0xb0,1,4,0,0,40, 0xb0,1,4,0,0,20, 0xb0,1,5,0,0,40, 0xc0,70,0,0,0,1};
  const red_mask_plan_t paint={.operation=RED_MASK_PAINT};
  uint8_t prefix[44],tail[44],reference[854],candidate[854];
  CHECK(red_black_pass_count(&paint)==3);
  CHECK(red_black_make_lut(2,&paint,0,prefix)==42 && red_black_make_lut(2,&paint,1,tail)==42);
  CHECK(expand_5ms(prefix,100,candidate,854)==244);
  CHECK(expand_5ms(tail,200,candidate+244,610)==610);
  CHECK(expand_5ms(fast47,200,reference,854)==854);
  CHECK(!memcmp(reference,candidate,854)); /* Nominal codes only, no pigment model. */
  CHECK(red_mask_frames(&paint)==911 && red_mask_nominal_ms(&paint)==6060);
  CHECK(red_black_pass_hz(&paint,0)==100 && red_black_pass_hz(&paint,1)==200);
  CHECK(red_black_pass_hz(&paint,2)==100 && red_black_pass_hz(&paint,3)==0);
}
#endif
#ifdef CODEPULSE_EPD_RED_MASK_TAIL100
static unsigned expand_levels(const uint8_t *lut,uint8_t *expanded,size_t capacity) {
  unsigned count=0;
  for(unsigned group=0;group<7;++group)
    for(unsigned repeat=0;repeat<lut[group*6+5];++repeat)
      for(unsigned phase=0;phase<4;++phase)
        for(unsigned frame=0;frame<lut[group*6+1+phase];++frame) {
          CHECK(count<capacity);
          expanded[count++]=(uint8_t)((lut[group*6]>>(6u-2u*phase))&3u);
        }
  return count;
}
static void check_tail100_reference(void) {
#if defined(CODEPULSE_EPD_RED_MASK_CRISP_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[300],w_a[300],red_b[290],w_b[290];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==300 && red_mask_nominal_ms(&paint_a)==3000);
  CHECK(red_mask_frames(&paint_b)==290 && red_mask_nominal_ms(&paint_b)==2900);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==300);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<300;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==3 && ra_tot[1]==6 && ra_tot[2]==65 && ra_tot[3]==226);
  for(unsigned f=35;f<41;++f) CHECK(red_a[f]==1);
  CHECK(red_a[41]==0);
  for(unsigned f=214;f<300;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==300);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<300;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<82) wa_early+=(w_a[f]==2);
    else if(f<148) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==101 && wa_tot[2]==199 && wa_early==47 && wa_mid==0 && wa_late==152);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==290);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<290;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==3 && rb_tot[1]==6 && rb_tot[2]==63 && rb_tot[3]==218);
  for(unsigned f=35;f<41;++f) CHECK(red_b[f]==1);
  CHECK(red_b[41]==0);
  for(unsigned f=207;f<290;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==290);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<290;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<75) wb_early+=(w_b[f]==2);
    else if(f<141) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==96 && wb_tot[2]==194 && wb_early==45 && wb_mid==0 && wb_late==149);
#elif defined(CODEPULSE_EPD_RED_MASK_VIVID_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[300],w_a[300],red_b[290],w_b[290];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==300 && red_mask_nominal_ms(&paint_a)==3000);
  CHECK(red_mask_frames(&paint_b)==290 && red_mask_nominal_ms(&paint_b)==2900);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==300);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<300;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==3 && ra_tot[1]==6 && ra_tot[2]==63 && ra_tot[3]==228);
  for(unsigned f=35;f<41;++f) CHECK(red_a[f]==1);
  CHECK(red_a[41]==0);
  for(unsigned f=204;f<300;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==300);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<300;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<72) wa_early+=(w_a[f]==2);
    else if(f<138) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==93 && wa_tot[2]==207 && wa_early==45 && wa_mid==0 && wa_late==162);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==290);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<290;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==3 && rb_tot[1]==11 && rb_tot[2]==58 && rb_tot[3]==218);
  for(unsigned f=32;f<43;++f) CHECK(red_b[f]==1);
  CHECK(red_b[43]==0);
  for(unsigned f=194;f<290;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==290);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<290;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<84) wb_early+=(w_b[f]==2);
    else if(f<139) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==90 && wb_tot[2]==200 && wb_early==49 && wb_mid==0 && wb_late==151);
#elif defined(CODEPULSE_EPD_RED_MASK_SMOOTH_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[300],w_a[300],red_b[290],w_b[290];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==300 && red_mask_nominal_ms(&paint_a)==3000);
  CHECK(red_mask_frames(&paint_b)==290 && red_mask_nominal_ms(&paint_b)==2900);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==300);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<300;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==3 && ra_tot[1]==6 && ra_tot[2]==69 && ra_tot[3]==222);
  for(unsigned f=35;f<41;++f) CHECK(red_a[f]==1);
  CHECK(red_a[41]==0);
  for(unsigned f=234;f<300;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==300);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<300;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<102) wa_early+=(w_a[f]==2);
    else if(f<168) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==117 && wa_tot[2]==183 && wa_early==51 && wa_mid==0 && wa_late==132);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==290);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<290;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==3 && rb_tot[1]==6 && rb_tot[2]==67 && rb_tot[3]==214);
  for(unsigned f=35;f<41;++f) CHECK(red_b[f]==1);
  CHECK(red_b[41]==0);
  for(unsigned f=212;f<290;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==290);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<290;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<102) wb_early+=(w_b[f]==2);
    else if(f<162) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==111 && wb_tot[2]==179 && wb_early==51 && wb_mid==0 && wb_late==128);
#elif defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[300],w_a[300],red_b[290],w_b[290];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==300 && red_mask_nominal_ms(&paint_a)==3000);
  CHECK(red_mask_frames(&paint_b)==290 && red_mask_nominal_ms(&paint_b)==2900);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==300);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<300;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==3 && ra_tot[1]==6 && ra_tot[2]==69 && ra_tot[3]==222);
  for(unsigned f=35;f<41;++f) CHECK(red_a[f]==1);
  CHECK(red_a[41]==0);
  for(unsigned f=246;f<300;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==300);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<300;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<102) wa_early+=(w_a[f]==2);
    else if(f<162) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==111 && wa_tot[2]==189 && wa_early==51 && wa_mid==0 && wa_late==138);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==290);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<290;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==3 && rb_tot[1]==6 && rb_tot[2]==57 && rb_tot[3]==224);
  for(unsigned f=35;f<41;++f) CHECK(red_b[f]==1);
  CHECK(red_b[41]==0);
  for(unsigned f=162;f<290;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==290);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<290;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<102) wb_early+=(w_b[f]==2);
    else if(f<162) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==111 && wb_tot[2]==179 && wb_early==51 && wb_mid==0 && wb_late==128);
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[300],w_a[300],red_b[590],w_b[590];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==300 && red_mask_nominal_ms(&paint_a)==3000);
  CHECK(red_mask_frames(&paint_b)==590 && red_mask_nominal_ms(&paint_b)==2950);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==200 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==300);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<300;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==3 && ra_tot[1]==6 && ra_tot[2]==81 && ra_tot[3]==210);
  for(unsigned f=35;f<41;++f) CHECK(red_a[f]==1);
  CHECK(red_a[41]==0);
  for(unsigned f=282;f<300;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==300);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<300;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<102) wa_early+=(w_a[f]==2);
    else if(f<162) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==111 && wa_tot[2]==189 && wa_early==51 && wa_mid==0 && wa_late==138);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==590);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<590;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==6 && rb_tot[1]==12 && rb_tot[2]==130 && rb_tot[3]==442);
  for(unsigned f=70;f<82;++f) CHECK(red_b[f]==1);
  CHECK(red_b[82]==0 && red_b[83]==0);
  for(unsigned f=556;f<590;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==590);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<590;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<266) wb_early+=(w_b[f]==2);
    else if(f<364) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==260 && wb_tot[2]==330 && wb_early==104 && wb_mid==0 && wb_late==226);
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[300],w_a[300],red_b[290],w_b[290];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==300 && red_mask_nominal_ms(&paint_a)==3000);
  CHECK(red_mask_frames(&paint_b)==290 && red_mask_nominal_ms(&paint_b)==2900);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==300);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<300;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==27 && ra_tot[1]==6 && ra_tot[2]==59 && ra_tot[3]==208);
  for(unsigned f=35;f<41;++f) CHECK(red_a[f]==1);
  CHECK(red_a[41]==0);
  for(unsigned f=284;f<300;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==300);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<300;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<114) wa_early+=(w_a[f]==2);
    else if(f<192) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==144 && wa_tot[2]==156 && wa_early==48 && wa_mid==0 && wa_late==108);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==290);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<290;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==3 && rb_tot[1]==6 && rb_tot[2]==69 && rb_tot[3]==212);
  for(unsigned f=35;f<41;++f) CHECK(red_b[f]==1);
  CHECK(red_b[41]==0);
  for(unsigned f=272;f<290;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==290);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<290;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<114) wb_early+=(w_b[f]==2);
    else if(f<174) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==123 && wb_tot[2]==167 && wb_early==51 && wb_mid==0 && wb_late==116);
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[280],w_a[280],red_b[265],w_b[265];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==280 && red_mask_nominal_ms(&paint_a)==2800);
  CHECK(red_mask_frames(&paint_b)==265 && red_mask_nominal_ms(&paint_b)==2650);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==280);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<280;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==3 && ra_tot[1]==6 && ra_tot[2]==54 && ra_tot[3]==217);
  for(unsigned f=30;f<36;++f) CHECK(red_a[f]==1);
  for(unsigned f=42;f<280;++f) CHECK(red_a[f]==2 || red_a[f]==3);
  for(unsigned f=235;f<280;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==280);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<280;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<90) wa_early+=(w_a[f]==2);
    else if(f<135) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==90 && wa_tot[2]==190 && wa_early==45 && wa_mid==0 && wa_late==145);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==265);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<265;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==3 && rb_tot[1]==6 && rb_tot[2]==50 && rb_tot[3]==206);
  for(unsigned f=30;f<36;++f) CHECK(red_b[f]==1);
  for(unsigned f=42;f<265;++f) CHECK(red_b[f]==2 || red_b[f]==3);
  for(unsigned f=217;f<265;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==265);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<265;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<78) wb_early+=(w_b[f]==2);
    else if(f<118) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==75 && wb_tot[2]==190 && wb_early==43 && wb_mid==0 && wb_late==147);
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[290],w_a[290],red_b[268],w_b[268];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==290 && red_mask_nominal_ms(&paint_a)==2900);
  CHECK(red_mask_frames(&paint_b)==268 && red_mask_nominal_ms(&paint_b)==2680);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==290);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<290;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==28 && ra_tot[1]==4 && ra_tot[2]==54 && ra_tot[3]==204);
  for(unsigned f=26;f<30;++f) CHECK(red_a[f]==1);
  for(unsigned f=36;f<255;++f) CHECK(!(red_a[f-1]==2 && red_a[f]==3));
  for(unsigned f=255;f<290;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==290);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<290;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<84) wa_early+=(w_a[f]==2);
    else if(f<147) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==108 && wa_tot[2]==182 && wa_early==39 && wa_mid==0 && wa_late==143);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==268);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<268;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==25 && rb_tot[1]==4 && rb_tot[2]==51 && rb_tot[3]==188);
  for(unsigned f=26;f<30;++f) CHECK(red_b[f]==1);
  for(unsigned f=36;f<230;++f) CHECK(!(red_b[f-1]==2 && red_b[f]==3));
  for(unsigned f=230;f<268;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==268);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<268;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<68) wb_early+=(w_b[f]==2);
    else if(f<122) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==85 && wb_tot[2]==183 && wb_early==37 && wb_mid==0 && wb_late==146);
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],red_a[280],w_a[280],red_b[230],w_b[230];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==280 && red_mask_nominal_ms(&paint_a)==2800);
  CHECK(red_mask_frames(&paint_b)==230 && red_mask_nominal_ms(&paint_b)==2300);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42 && expand_levels(lut,red_a,sizeof(red_a))==280);
  unsigned ra_tot[4]={0};
  for(unsigned f=0;f<280;++f) ++ra_tot[red_a[f]];
  CHECK(ra_tot[0]==9 && ra_tot[1]==4 && ra_tot[2]==49 && ra_tot[3]==218);
  for(unsigned f=26;f<30;++f) CHECK(red_a[f]==1);
  for(unsigned f=216;f<280;++f) CHECK(red_a[f]==3);
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==280);
  unsigned wa_tot[4]={0}, wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<280;++f) {
    CHECK(w_a[f]==0 || w_a[f]==2);
    ++wa_tot[w_a[f]];
    if(f<84) wa_early+=(w_a[f]==2);
    else if(f<140) wa_mid+=(w_a[f]==2);
    else wa_late+=(w_a[f]==2);
  }
  CHECK(wa_tot[0]==101 && wa_tot[2]==179 && wa_early==39 && wa_mid==0 && wa_late==140);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==230);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<230;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==7 && rb_tot[1]==0 && rb_tot[2]==39 && rb_tot[3]==184);
  for(unsigned f=162;f<230;++f) CHECK(red_b[f]==3);
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==230);
  unsigned wb_tot[4]={0}, wb_early=0, wb_mid=0, wb_late=0;
  for(unsigned f=0;f<230;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<61) wb_early+=(w_b[f]==2);
    else if(f<93) wb_mid+=(w_b[f]==2);
    else wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==39 && wb_tot[2]==191 && wb_early==54 && wb_mid==0 && wb_late==137);
#elif defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
  const uint8_t shift55_r22[42]={
      0xa0,26,26,10,0,1, 0x84,14,1,14,1,1, 0x90,10,10,0,0,1,
      0xb0,1,4,0,0,30, 0x8c,1,1,5,0,10, 0x8c,1,2,5,0,10, 0xc0,35,0,0,0,1};
  const red_mask_plan_t paint_a={.operation=RED_MASK_PAINT,.group_b=false};
  const red_mask_plan_t paint_b={.operation=RED_MASK_PAINT,.group_b=true};
  uint8_t lut[44],ref_a[447],red_a[447],w_a[447],red_b[380],w_b[380];
  CHECK(red_black_pass_count(&paint_a)==1 && red_black_pass_count(&paint_b)==1);
  CHECK(red_mask_frames(&paint_a)==447 && red_mask_nominal_ms(&paint_a)==4470);
  CHECK(red_mask_frames(&paint_b)==380 && red_mask_nominal_ms(&paint_b)==3800);
  CHECK(red_black_pass_hz(&paint_a,0)==100 && red_black_pass_hz(&paint_a,1)==0);
  CHECK(red_black_pass_hz(&paint_b,0)==100 && red_black_pass_hz(&paint_b,1)==0);
  CHECK(red_black_make_lut(2,&paint_a,0,lut)==42);
  CHECK(expand_levels(shift55_r22,ref_a,sizeof(ref_a))==447);
  CHECK(expand_levels(lut,red_a,sizeof(red_a))==447 && !memcmp(ref_a,red_a,447));
  CHECK(red_black_make_lut(4,&paint_a,0,lut)==42 && expand_levels(lut,w_a,sizeof(w_a))==447);
  unsigned wa_tot[4]={0};
  for(unsigned f=0;f<447;++f) { CHECK(w_a[f]==0 || w_a[f]==2); ++wa_tot[w_a[f]]; }
  CHECK(wa_tot[0]==262 && wa_tot[2]==185);
  unsigned wa_early=0, wa_mid=0, wa_late=0;
  for(unsigned f=0;f<112;++f) wa_early+=(w_a[f]==2);
  for(unsigned f=112;f<332;++f) wa_mid+=(w_a[f]==2);
  for(unsigned f=332;f<447;++f) wa_late+=(w_a[f]==2);
  CHECK(wa_early==90 && wa_mid==0 && wa_late==95);
  CHECK(red_black_make_lut(2,&paint_b,0,lut)==42 && expand_levels(lut,red_b,sizeof(red_b))==380);
  unsigned rb_tot[4]={0};
  for(unsigned f=0;f<380;++f) ++rb_tot[red_b[f]];
  CHECK(rb_tot[0]==44 && rb_tot[1]==14 && rb_tot[2]==76 && rb_tot[3]==246);
  for(unsigned f=63;f<342;++f) CHECK(!(red_b[f-1]==2 && red_b[f]==3)); /* Tail reversals separated by 0V. */
  CHECK(red_black_make_lut(4,&paint_b,0,lut)==42 && expand_levels(lut,w_b,sizeof(w_b))==380);
  unsigned wb_tot[4]={0}, wb_early=0, wb_late=0;
  for(unsigned f=0;f<380;++f) {
    CHECK(w_b[f]==0 || w_b[f]==2);
    ++wb_tot[w_b[f]];
    if(f<174) wb_early+=(w_b[f]==2);
    if(f>=270) wb_late+=(w_b[f]==2);
  }
  CHECK(wb_tot[0]==208 && wb_tot[2]==172 && wb_early==70 && wb_late==102);
#elif defined(CODEPULSE_EPD_RED_MASK_GAP_SHIFT)
  const uint8_t gap52[42]={
      0xa0,26,26,0,0,1, 0x00,10,10,0,0,1,
      0x84,14,1,14,1,1, 0x90,10,10,0,0,1,
      0xb0,1,4,0,0,30, 0x8c,1,1,5,0,20, 0xc0,35,0,0,0,1};
  const red_mask_plan_t paint={.operation=RED_MASK_PAINT};
  uint8_t lut[44],reference[447],candidate[447];
  CHECK(red_black_make_lut(2,&paint,0,lut)==42);
  CHECK(expand_levels(gap52,reference,sizeof(reference))==447);
  CHECK(expand_levels(lut,candidate,sizeof(candidate))==447);
  CHECK(!memcmp(reference,candidate,62));
  for(unsigned frame=62;frame<72;++frame) CHECK(reference[frame]==0);
  CHECK(!memcmp(reference+72,candidate+62,270));
  for(unsigned repeat=0;repeat<10;++repeat) {
    const unsigned old_start=342+7*repeat;
    const unsigned new_start=332+8*repeat;
    CHECK(!memcmp(reference+old_start,candidate+new_start,2));
    CHECK(candidate[new_start+2]==0);
    CHECK(!memcmp(reference+old_start+2,candidate+new_start+3,5));
  }
  CHECK(!memcmp(reference+412,candidate+412,35));
  CHECK(red_mask_frames(&paint)==626 && red_mask_nominal_ms(&paint)==6260);
  CHECK(red_black_pass_hz(&paint,0)==100 && red_black_pass_hz(&paint,1)==100);
  CHECK(red_black_pass_hz(&paint,2)==0);
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
  const uint8_t tail48[42]={
      0xa0,26,26,0,0,1, 0x00,10,10,0,0,1,
      0x84,14,1,14,1,1, 0x90,10,10,0,0,1,
      0xb0,1,4,0,0,30, 0xb0,1,5,0,0,20, 0xc0,35,0,0,0,1};
  const red_mask_plan_t paint={.operation=RED_MASK_PAINT};
  uint8_t lut[44],reference[427],candidate[447];
  CHECK(red_black_make_lut(2,&paint,0,lut)==42);
  CHECK(expand_levels(tail48,reference,sizeof(reference))==427);
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_FINISH
  const unsigned candidate_frames=431, gap_repeats=12;
#else
  const unsigned candidate_frames=447, gap_repeats=20;
#endif
  CHECK(expand_levels(lut,candidate,sizeof(candidate))==candidate_frames);
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_PAIR
  CHECK(!memcmp(reference,candidate,122));
  unsigned reference_budget[4]={0},candidate_budget[4]={0};
  for(unsigned frame=0;frame<150;++frame) {
    const unsigned expected=frame%10<2?2u:3u;
    CHECK(candidate[122+frame]==expected);
    ++reference_budget[reference[122+frame]];
    ++candidate_budget[candidate[122+frame]];
  }
  CHECK(!memcmp(reference_budget,candidate_budget,sizeof(reference_budget)));
#else
  CHECK(!memcmp(reference,candidate,272));
#endif
  for(unsigned repeat=0;repeat<gap_repeats;++repeat) {
    const unsigned original=272+6*repeat;
    const unsigned with_gap=272+7*repeat;
    CHECK(candidate[with_gap]==reference[original]);
    CHECK(candidate[with_gap+1]==0);
    CHECK(!memcmp(candidate+with_gap+2,reference+original+1,5));
  }
  const unsigned finish_start=272+7*gap_repeats;
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_FINISH
  CHECK(candidate_frames-finish_start==75);
  for(unsigned frame=finish_start;frame<candidate_frames;++frame) {
    CHECK(candidate[frame]==3);
  }
  unsigned totals[4]={0};
  for(unsigned frame=0;frame<candidate_frames;++frame) ++totals[candidate[frame]];
  CHECK(totals[0]==34 && totals[1]==24 && totals[2]==118 && totals[3]==255);
#else
  CHECK(!memcmp(candidate+finish_start,reference+392,35));
#endif
  CHECK(red_mask_frames(&paint)==candidate_frames+179);
  CHECK(red_mask_nominal_ms(&paint)==(candidate_frames+179)*10);
  CHECK(red_black_pass_hz(&paint,0)==100 && red_black_pass_hz(&paint,1)==100);
  CHECK(red_black_pass_hz(&paint,2)==0);
#else
  /* Frozen .46 reference, independent of the new LUT. Compare the actual
   * nominal level sequence and budgets; this does not model pigments. */
  const uint8_t color46[42]={
      0xa0,26,26,0,0,1, 0x00,10,10,0,0,1,
      0x84,14,1,14,1,1, 0x90,10,10,0,0,1,
      0xb0,4,16,0,0,5, 0xb0,3,14,0,0,10, 0xc0,35,0,0,0,1};
  const red_mask_plan_t paint={.operation=RED_MASK_PAINT};
  uint8_t lut[44],reference[427],candidate[427];
  CHECK(red_black_make_lut(2,&paint,0,lut)==42);
  CHECK(expand_levels(color46,reference,sizeof(reference))==427 && expand_levels(lut,candidate,sizeof(candidate))==427);
  CHECK(!memcmp(reference,candidate,122));
  CHECK(!memcmp(reference+392,candidate+392,35));
  unsigned reference_total[4]={0},candidate_total[4]={0};
  for(unsigned frame=0;frame<427;++frame) {
    ++reference_total[reference[frame]];++candidate_total[candidate[frame]];
  }
#ifdef CODEPULSE_EPD_RED_MASK_NEUTRAL
  CHECK(reference_total[2]==candidate_total[2]+50);
  CHECK(candidate_total[0]==reference_total[0]+50);
  CHECK(candidate_total[1]==reference_total[1] && candidate_total[3]==reference_total[3]);
  const unsigned first_level=0;
#else
  CHECK(!memcmp(reference_total,candidate_total,sizeof(reference_total)));
  const unsigned first_level=2;
#endif
  unsigned pauses_or_reverse=0,red_drive=0,run=0,last=4;
  for(unsigned frame=122;frame<392;++frame) {
    const unsigned level=candidate[frame];
    CHECK(level==first_level || level==3);
    pauses_or_reverse+=level==first_level;red_drive+=level==3;
    run=level==last?run+1u:1u;last=level;
    CHECK(run<=(level==first_level?1u:5u));
  }
  CHECK(pauses_or_reverse==50 && red_drive==220);
  CHECK(red_mask_frames(&paint)==606 && red_mask_nominal_ms(&paint)==6060);
  CHECK(red_black_pass_hz(&paint,0)==100 && red_black_pass_hz(&paint,1)==100);
  CHECK(red_black_pass_hz(&paint,2)==0);
#endif
}
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
static void check_stagger_reference(void) {
  const uint8_t tail48[42]={
      0xa0,26,26,0,0,1, 0x00,10,10,0,0,1,
      0x84,14,1,14,1,1, 0x90,10,10,0,0,1,
      0xb0,1,4,0,0,30, 0xb0,1,5,0,0,20, 0xc0,35,0,0,0,1};
  const red_mask_plan_t paint={.operation=RED_MASK_PAINT};
  uint8_t lut_a[44],lut_b[44],reference[427],a[427],b[427];
  CHECK(red_black_make_lut(2,&paint,0,lut_a)==42 && red_black_make_lut(4,&paint,0,lut_b)==42);
  CHECK(expand_levels(tail48,reference,sizeof(reference))==427 &&
      expand_levels(lut_a,a,sizeof(a))==427 && expand_levels(lut_b,b,sizeof(b))==427);
  CHECK(!memcmp(reference,a,427));
  CHECK(!memcmp(reference,b,122) && !memcmp(reference+392,b+392,35));
  unsigned totals_a[4]={0},totals_b[4]={0},reverse_a=0,reverse_b=0;
  for(unsigned frame=0;frame<427;++frame) {++totals_a[a[frame]];++totals_b[b[frame]];}
  CHECK(!memcmp(totals_a,totals_b,sizeof(totals_a)));
  for(unsigned frame=122;frame<392;++frame) {
    CHECK((a[frame]==2 || a[frame]==3) && (b[frame]==2 || b[frame]==3));
    CHECK(a[frame]!=2 || b[frame]!=2);
    reverse_a+=a[frame]==2;reverse_b+=b[frame]==2;
  }
  CHECK(reverse_a==50 && reverse_b==50); /* Full .48 reverse dose, no overlap. */
}
#endif
#endif
int main(void) {
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
  check_split_reference();
#endif
#ifdef CODEPULSE_EPD_RED_MASK_TAIL100
  check_tail100_reference();
#endif
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
  check_stagger_reference();
#endif
  epd_quiet_metrics_t m;
  red_mask_plan_t invalid_plan={.operation=RED_MASK_ERASE};
  CHECK(red_mask_frames(&invalid_plan)==179 && red_mask_nominal_ms(&invalid_plan)==1790);
#ifdef CODEPULSE_EPD_RED_MASK_FAST
  red_mask_plan_t paint_budget={.operation=RED_MASK_PAINT};
  CHECK(red_mask_frames(&paint_budget)==1033 && red_mask_nominal_ms(&paint_budget)==6060);
  CHECK(red_black_pass_hz(&paint_budget,0)==200 && red_black_pass_hz(&paint_budget,1)==100);
  CHECK(red_black_pass_hz(&paint_budget,2)==0);
#endif
  uint8_t invalid_lut[44];
  CHECK(!red_mask_make_lut(5,&invalid_plan,invalid_lut) && !red_mask_make_lut(0,&invalid_plan,NULL));
  /* Regression: a missing explicit DDX write can reverse canvas red selection. */
  CHECK(selected_table(0xd7,true,true)==0x22);
  CHECK(selected_table(0xf7,true,true)==0x23);
  CHECK(selected_table(0xf7,true,false)==0x24);
  CHECK(selected_table(0xf7,false,true)==0x22);
  /* All nine before/after pairs, for every intended pass. Black must use
   * R24 both while clearing and when writing; unchanged pixels always HOLD. */
  const uint8_t bs[3]={255,0,255},rs[3]={255,255,0};
  for(unsigned before=0;before<3;++before)
    for(unsigned after=0;after<3;++after) {
      red_mask_plan_t p={.operation=after==2?RED_MASK_PAINT:RED_MASK_ERASE,
          .black_pixels=after==1 && before!=after?1u:0u};
      const unsigned count=red_black_pass_count(&p);
      CHECK(count==(after==2?TEST_PAINT_PASSES:(after==1 && before!=after?2u:1u)));
      CHECK(red_black_pass_frames(&p,count)==0);
      uint8_t unused[44]; CHECK(red_black_make_lut(4,&p,count,unused)==0);
      for(unsigned pass=0;pass<count;++pass) {
        uint8_t mb,mr;
        red_black_encode(&p,pass,bs[after],rs[after],bs[before],rs[before],&mb,&mr);
        const uint8_t selected=selected_table(0xf7,mr!=0,mb!=0);
        uint8_t wanted=before==after?0x23:(after==2?0x22:0x24);
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
        if(before!=after && after==2 && pass==0) wanted=0x24;
#endif
        CHECK(selected==wanted);
        if(after!=2) CHECK(mr==255);
      }
    }
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
  /* Local white cleanup deliberately includes unchanged glyph holes. All
   * nine input pairs, outside bytes and invalid passes must obey the scope. */
  const unsigned glyph_pass=TEST_PAINT_PASSES-1u;
  for(unsigned from=0;from<3;++from) for(unsigned to=0;to<3;++to)
    for(unsigned pass=0;pass<=TEST_PAINT_PASSES;++pass) for(unsigned inside=0;inside<2;++inside) {
      uint8_t mb,mr;red_activation_encode(pass,inside!=0,bs[to],rs[to],bs[from],rs[from],&mb,&mr);
      const uint8_t selected=selected_table(0xf7,mr!=0,mb!=0);
      uint8_t wanted=0x23;
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
      (void)glyph_pass;
      if(inside && pass==0) {
        if(from!=to && to==2) wanted=0x22;
        else if(to==0) wanted=0x24;
      }
#else
      if(inside && pass<glyph_pass && from!=to && to==2) wanted=0x22;
      if(inside && pass==glyph_pass && to==0) wanted=0x24;
#endif
      CHECK(selected==wanted);
    }
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
  for(unsigned from=0;from<3;++from) for(unsigned to=0;to<3;++to)
    for(unsigned pass=0;pass<=2;++pass) for(unsigned inside=0;inside<2;++inside)
      for(unsigned row=0;row<2;++row) {
        uint8_t mb,mr;
        red_stagger_encode(pass,inside!=0,row!=0,bs[to],rs[to],bs[from],rs[from],&mb,&mr);
        for(unsigned bit=0;bit<8;++bit) {
          const unsigned mask=0x80u>>bit;
          uint8_t wanted=0x23;
          if(inside && pass==0 && from!=to && to==2) wanted=((bit+row)&1u)?0x24:0x22;
          if(inside && pass==1 && to==0) wanted=0x24;
          CHECK(selected_table(0xf7,(mr&mask)!=0,(mb&mask)!=0)==wanted);
        }
      }
#endif
#endif
  /* Reject a third driven target color without issuing any SPI transaction. */
  cold();baseline();unsigned before_spi=spi_calls;bool injected=false;
  for(unsigned y=130;y<158 && !injected;++y)
    for(unsigned x=160;x<240 && !injected;++x) {
      const unsigned i=y*50+x/8,mask=0x80u>>(x%8);
      if(previous_red[i]&mask) {
        black[i]|=(uint8_t)mask;red[i]&=(uint8_t)~mask;injected=true;
      }
    }
  CHECK(injected && update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before_spi);
  transitions(); for(unsigned i=0;i<=2;++i) ppm(i);
  const uint8_t inherited_cdi[]={0xd7,0xf7,0x77};
  for(unsigned inherited=0;inherited<3;++inherited) {
    cold(); baseline(); cdi=inherited_cdi[inherited]; pll=0x3c;
    CHECK(update(&m)==ESP_OK && s_epd_baseline_valid && m.busy_seen);
    CHECK(m.refresh_ms>=3300 && m.refresh_ms<3460 && m.x==160 && m.width==80);
    CHECK(resets==1 && clean_drives==1 && lut_drives==2 && power_offs==2);
    CHECK(!memcmp(ram[0],black,15000) && !memcmp(ram[1],red,15000));
    memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
    CHECK(red_mask_draw(&canvas,2));
    CHECK(update(&m)==ESP_OK && s_epd_baseline_valid);
    CHECK(m.refresh_ms>=TEST_PAINT_MIN_MS && m.refresh_ms<TEST_PAINT_MAX_MS && lut_drives==2u+TEST_PAINT_PASSES && power_offs==3 && resets==1);
    CHECK(pll==0x3a); /* The accepted white/erase clock is restored. */
#if defined(CODEPULSE_EPD_RED_MASK_FAST) || defined(CODEPULSE_EPD_RED_MASK_SPLIT)
    CHECK(pll_writes==3); /* Initial 100Hz, red 200Hz, white 100Hz. */
#endif
#ifdef CODEPULSE_EPD_RED_MASK_TAIL100
    CHECK(pll_writes==1); /* Keep .46's single 100Hz setting throughout. */
#endif
    CHECK(!memcmp(ram[0],black,15000) && !memcmp(ram[1],red,15000));
  }
  unsigned fault_points=0;
  for(unsigned transition=1;transition<=2;++transition) {
    cold(); baseline();
    if (transition==2) {
      CHECK(update(&m)==ESP_OK);
      memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
      CHECK(red_mask_draw(&canvas,2));
    }
    unsigned before=spi_calls; CHECK(update(&m)==ESP_OK); const unsigned calls=spi_calls-before;
    fault_points+=calls;
    for(unsigned failure=1;failure<=calls;++failure) {
      cold(); baseline();
      if (transition==2) {
        CHECK(update(&m)==ESP_OK);
        memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
        CHECK(red_mask_draw(&canvas,2));
      }
      fail_at=spi_calls+failure;
      CHECK(update(&m)!=ESP_OK && !s_epd_baseline_valid && lut_drives==failure_lut_drives && resets==1);
      before=spi_calls; CHECK(update(&m)==ESP_ERR_INVALID_STATE && spi_calls==before);
    }
  }
  cold(); baseline(); slow_clear=true;
  CHECK(update(&m)==ESP_ERR_INVALID_RESPONSE && !s_epd_baseline_valid && lut_drives==1);
  CHECK(pass_index==1 && power_offs==2); /* Never continue into black after a slow clear. */
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  cold(); baseline(); CHECK(update(&m)==ESP_OK);
  memcpy(previous_black,black,15000);memcpy(previous_red,red,15000);
  CHECK(red_mask_draw(&canvas,2));slow_clear=true;
  CHECK(update(&m)==ESP_ERR_INVALID_RESPONSE && !s_epd_baseline_valid && lut_drives==3);
  CHECK(pass_index==1); /* No second stage after the first exceeds its limit. */
#if TEST_PAINT_PASSES >= 2u
  cold(); baseline(); CHECK(update(&m)==ESP_OK);
  memcpy(previous_black,black,15000);memcpy(previous_red,red,15000);
  CHECK(red_mask_draw(&canvas,2));slow_color=true;
  CHECK(update(&m)==ESP_ERR_INVALID_RESPONSE && !s_epd_baseline_valid && lut_drives==4);
  CHECK(pass_index==2 && power_offs==3); /* No extra pulse or accepted RAM baseline. */
#endif
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
  cold(); baseline(); CHECK(update(&m)==ESP_OK);
  memcpy(previous_black,black,15000);memcpy(previous_red,red,15000);
  CHECK(red_mask_draw(&canvas,2));slow_white=true;
  CHECK(update(&m)==ESP_ERR_INVALID_RESPONSE && !s_epd_baseline_valid && lut_drives==5);
  CHECK(pass_index==3 && power_offs==3);
  cold(); baseline(); CHECK(update(&m)==ESP_OK);
  memcpy(previous_black,black,15000);memcpy(previous_red,red,15000);
  CHECK(red_mask_draw(&canvas,2));slow_red_combined=true;
  CHECK(update(&m)==ESP_ERR_INVALID_RESPONSE && !s_epd_baseline_valid && lut_drives==4);
  CHECK(pass_index==2 && power_offs==3); /* Combined red bound stops before white. */
#endif
#endif
  cold(); baseline(); stuck_refresh=true; CHECK(update(&m)==ESP_ERR_TIMEOUT && !s_epd_baseline_valid && power_offs==1);
  cold(); baseline(); no_busy_refresh=true; CHECK(update(&m)==ESP_ERR_INVALID_RESPONSE && !s_epd_baseline_valid);
  cold(); baseline(); stuck_power=true; CHECK(update(&m)==ESP_ERR_TIMEOUT && lut_drives==0 && !s_epd_baseline_valid);
  cold(); baseline(); stuck_off=true; CHECK(update(&m)==ESP_ERR_TIMEOUT && !s_epd_baseline_valid);
  cold(); baseline(); epd_hardware_reset(); unsigned before=spi_calls;
  CHECK(update(&m)==ESP_ERR_INVALID_STATE && spi_calls==before);
  cold(); baseline(); CHECK(epd_ssd1683_deep_sleep()==ESP_OK); before=spi_calls;
  CHECK(update(&m)==ESP_ERR_INVALID_STATE && spi_calls==before);
  cold(); baseline(); busy_until=now_us+30000; before=spi_calls;
  CHECK(update(&m)==ESP_ERR_INVALID_STATE && spi_calls==before && !s_epd_baseline_valid);
  cold(); baseline(); before=spi_calls; black[0]^=1;
  CHECK(update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before);
  cold(); baseline(); before=spi_calls; red[0]^=1;
  CHECK(update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before);
  cold(); baseline(); before=spi_calls; memcpy(red,previous_red,15000);
  CHECK(update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before);
  cold(); baseline(); before=spi_calls;
  CHECK(update(NULL)==ESP_ERR_INVALID_ARG && spi_calls==before);
  CHECK(epd_red_mask_refresh(NULL,previous_black,previous_red,15000,160,130,80,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,black,previous_red,15000,160,130,80,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,14999,160,130,80,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,160,299,80,2,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,160,130,80,0,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,161,130,80,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,160,130,79,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,160,130,8,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,400,130,80,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,392,130,16,28,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_mask_refresh(&canvas,previous_black,previous_red,15000,160,130,80,1,&m)==ESP_ERR_INVALID_ARG);
  CHECK(spi_calls==before);
  /* Same-row changes to either plane, even on only one side, must be rejected
   * before touching hardware. This catches the former vertical-only guard. */
  for(unsigned side=0;side<2;++side) {
    const unsigned i=140u*50u+(side?32u:15u);
    for(unsigned plane=0;plane<2;++plane) {
      cold(); baseline(); before=spi_calls;
      CHECK(black[i]==255 && red[i]==255);
      (plane?red:black)[i]^=1;
      CHECK(update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before);
    }
  }
  cold(); baseline(); before=spi_calls;
  red[140*50+20]=black[140*50+20]=0;
  CHECK(update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before);
#ifdef CODEPULSE_EPD_RED_MASK_SCAN_AB
  check_scan_ab_traces();
#elif defined(CODEPULSE_EPD_RED_MASK_GAP_SHIFT)
  cold();
  const long offset = record_shift55_trial("spi-shift55.bin", false);
  printf("Recorded Shift55 SPI reference; red R90 data byte 9 at offset %ld\n", offset);
#endif
  printf("PASS: whole-driver SPI, explicit BWR/DDX/PLL, 5 LUTs including 0x21 after wake, 120000 pixel color routing, 80x28 actual-red removal/reappearance, same-row and outside RAM guards, 9 color-pair masks, scoped white-glyph redraw only in ACTIVATE, clear-before-black, black uses R24 only, per-pass timing stop, canonical frames after planned passes, canonical RAM restoration, retained state; %u transaction faults; BUSY/reset/sleep/shutdown; no optics simulated\n",fault_points);
  return 0;
}
