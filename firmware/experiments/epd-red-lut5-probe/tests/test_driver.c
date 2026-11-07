/* Execute the whole production driver plus the candidate against a bounded
 * SPI/register model. The model checks data/lifecycle, NOT electrophoretics. */
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "test_check.h"
#include "panel_host.h"
#define CODEPULSE_EPD_RED_LUT5_PROBE 1
#include "../../../main/epd_ssd1683.c"

static int64_t now_us, busy_until;
static unsigned spi_calls, fail_at, resets, clean_drives, lut_drives, power_offs;
static unsigned power_ons, tables, pll_writes, cdi_writes;
static int dc;
static uint8_t cmd, psr, pll, cdi, calibration_marker;
static bool partial, stuck_refresh, no_busy_refresh, stuck_power, stuck_off;
static size_t cursor, uploaded[2], table_lengths[5];
static uint8_t ram[2][15000], luts[5][44];
static uint8_t displayed_black[15000], displayed_red[15000];
static uint8_t black[15000], red[15000], previous_black[15000], previous_red[15000];
static red_lut5_profile_t current_profile;
static epd_canvas_t canvas={.black=black,.red=red};

/* Independent reference bytes from beee's GDEW042Z15 table, 2018-03-03. */
static const uint8_t full_tables[5][44]={
{0x00,26,26,0,0,1, 0x00,10,10,0,0,8, 0x00,14,1,14,1,16, 0x00,10,10,0,0,8,
  0x00,4,16,0,0,5, 0x00,3,14,0,0,10, 0x00,35,0,0,0,1, 0,0},
{0x90,26,26,0,0,1, 0x40,10,10,0,0,8, 0x84,14,1,14,1,16, 0x80,10,10,0,0,8,
  0x00,4,16,0,0,5, 0x00,3,14,0,0,10, 0x00,35,0,0,0,1},
{0xa0,26,26,0,0,1, 0x00,10,10,0,0,8, 0x84,14,1,14,1,16, 0x90,10,10,0,0,8,
  0xb0,4,16,0,0,5, 0xb0,3,14,0,0,10, 0xc0,35,0,0,0,1},
{0x90,26,26,0,0,1, 0x40,10,10,0,0,8, 0x84,14,1,14,1,16, 0x80,10,10,0,0,8,
  0x00,4,16,0,0,5, 0x00,3,14,0,0,10, 0x00,35,0,0,0,1},
{0x90,26,26,0,0,1, 0x20,10,10,0,0,8, 0x84,14,1,14,1,16, 0x10,10,10,0,0,8,
  0x00,4,16,0,0,5, 0x00,3,14,0,0,10, 0x00,35,0,0,0,1}
};

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

static void check_candidate_drive(void) {
  CHECK(psr==0x2f && pll==0x3a && cdi==0xf7 && partial && calibration_marker==0x51);
  CHECK(pll_writes && cdi_writes && tables==5 && uploaded[0]==15000 && uploaded[1]==15000);
  CHECK(!memcmp(ram[0],black,15000) && !memcmp(ram[1],red,15000));
  for(unsigned table=0;table<5;++table) {
    uint8_t expected[44]; memcpy(expected,full_tables[table],44);
    if(current_profile==RED_LUT5_SHORT) { expected[11]=4; expected[17]=8; expected[23]=4; }
    CHECK(table_lengths[table]==(table?42u:44u) && !memcmp(luts[table],expected,table_lengths[table]));
    CHECK(frames(luts[table])==(current_profile==RED_LUT5_FULL?1157u:757u));
  }
  for(size_t i=0;i<15000;++i) {
    if(i<128*50u || i>=168*50u) {
      CHECK(ram[0][i]==displayed_black[i] && ram[1][i]==displayed_red[i]);
    }
    for(unsigned bit=0;bit<8;++bit) {
      const uint8_t mask=(uint8_t)(0x80u>>bit);
      const uint8_t wanted=!(red[i]&mask)?0x22:(!(black[i]&mask)?0x24:0x23);
      CHECK(selected_table(cdi,(ram[1][i]&mask)!=0,(ram[0][i]&mask)!=0)==wanted);
    }
  }
  ++lut_drives;
  if(stuck_refresh) busy_until=now_us+60000000;
  else if(no_busy_refresh) busy_until=now_us;
  else busy_until=now_us+(int64_t)frames(luts[0])*10000;
}
esp_err_t spi_device_polling_transmit(spi_device_handle_t dev,spi_transaction_t *tx) {
  CHECK(dev && tx->length%8==0); ++spi_calls; now_us+=100;
  if(spi_calls==fail_at) return ESP_FAIL;
  const uint8_t *data=tx->tx_buffer;
  const size_t length=tx->length/8;
  CHECK(length<=1024);
  if(!dc) {
    CHECK(length==1); cmd=data[0]; cursor=0;
    /* Reject voltage, VCOM_DC, OTP programming, and unreviewed commands. */
    CHECK(cmd==0x00 || cmd==0x02 || cmd==0x04 || cmd==0x06 || cmd==0x07 ||
        cmd==0x10 || cmd==0x12 || cmd==0x13 || (cmd>=0x20 && cmd<=0x24) ||
        cmd==0x30 || cmd==0x50 || cmd==0x61 || cmd==0x71 || cmd==0x90 || cmd==0x91 || cmd==0x92);
    if(cmd==0x04) {
      ++power_ons; tables=pll_writes=cdi_writes=0;
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
      memcpy(displayed_black,black,15000); memcpy(displayed_red,red,15000);
    }
    return ESP_OK;
  }
  if(cmd==0x00) { CHECK(length==1); psr=data[0]; }
  else if(cmd==0x30) { CHECK(length==1 && data[0]==0x3a && now_us>=busy_until); pll=data[0]; ++pll_writes; }
  else if(cmd==0x50) { CHECK(length==1); cdi=data[0]; ++cdi_writes; }
  else if(cmd==0x61) { const uint8_t expected[]={1,144,1,44}; CHECK(length==4 && !memcmp(data,expected,4)); }
  else if(cmd==0x90) {
    const uint8_t expected[]={0,0,1,143,0,128,0,167,0};
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
  power_ons=tables=pll_writes=cdi_writes=0; dc=0; partial=false;
  stuck_refresh=no_busy_refresh=stuck_power=stuck_off=false;
  s_spi=NULL; s_epd_baseline_valid=false; current_profile=RED_LUT5_FULL;
  CHECK(red_lut5_draw(&canvas,0)); CHECK(epd_ssd1683_init()==ESP_OK);
}
static void baseline(void) {
  uint32_t duration=0;
  CHECK(epd_ssd1683_refresh(&canvas,&duration)==ESP_OK);
  CHECK(s_epd_baseline_valid && resets==1 && clean_drives==1 && power_offs==1);
  memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
  CHECK(red_lut5_draw(&canvas,1));
}
static esp_err_t update(epd_quiet_metrics_t *m) {
  return epd_red_lut5_refresh(&canvas,previous_black,previous_red,15000,128,40,current_profile,m);
}
static void ppm(unsigned frame) {
  CHECK(red_lut5_draw(&canvas,frame)); char name[32]; snprintf(name,sizeof(name),"frame-%u.ppm",frame);
  FILE *f=fopen(name,"wb"); CHECK(f); fprintf(f,"P6\n400 300\n255\n");
  for(unsigned bit=0;bit<120000;++bit) {
    const unsigned mask=0x80u>>(bit%8); unsigned char p[3]={255,255,255};
    if(!(red[bit/8]&mask)) { p[0]=190; p[1]=p[2]=30; }
    else if(!(black[bit/8]&mask)) p[0]=p[1]=p[2]=0;
    CHECK(fwrite(p,1,3,f)==3);
  }
  CHECK(fclose(f)==0);
}
static void transitions(void) {
  cold(); memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
  for(unsigned step=1;step<=2;++step) {
    CHECK(red_lut5_draw(&canvas,step)); unsigned counts[3][3]={{0}};
    CHECK(red_lut5_validate(&canvas,previous_black,previous_red,15000,128,40)==ESP_OK);
    for(unsigned bit=0;bit<120000;++bit) {
      const unsigned i=bit/8, mask=0x80u>>(bit%8);
      const unsigned before=!(previous_red[i]&mask)?2u:(!(previous_black[i]&mask)?1u:0u);
      const unsigned after=!(red[i]&mask)?2u:(!(black[i]&mask)?1u:0u);
      ++counts[before][after];
    }
    if (step==1) {
      CHECK(counts[2][0] && counts[2][1] && !counts[0][2] && !counts[1][2]);
      for(unsigned i=128*50u;i<168*50u;++i) CHECK(red[i]==255);
    } else CHECK(counts[0][2] && counts[1][2] && !counts[2][0] && !counts[2][1]);
    memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
  }
}
int main(void) {
  epd_quiet_metrics_t m;
  /* Regression: a missing explicit DDX write can reverse canvas red selection. */
  CHECK(selected_table(0xd7,true,true)==0x22);
  CHECK(selected_table(0xf7,true,true)==0x23);
  CHECK(selected_table(0xf7,true,false)==0x24);
  CHECK(selected_table(0xf7,false,true)==0x22);
  transitions(); for(unsigned i=0;i<=2;++i) ppm(i);
  const uint8_t inherited_cdi[]={0xd7,0xf7,0x77};
  for(unsigned inherited=0;inherited<3;++inherited) {
    cold(); baseline(); cdi=inherited_cdi[inherited]; pll=0x3c;
    CHECK(update(&m)==ESP_OK && s_epd_baseline_valid && m.busy_seen);
    CHECK(m.refresh_ms>=11570 && m.refresh_ms<11650 && m.width==400);
    CHECK(resets==1 && clean_drives==1 && lut_drives==1 && power_offs==2);
    memcpy(previous_black,black,15000); memcpy(previous_red,red,15000);
    CHECK(red_lut5_draw(&canvas,2)); current_profile=RED_LUT5_SHORT;
    CHECK(update(&m)==ESP_OK && s_epd_baseline_valid);
    CHECK(m.refresh_ms>=7570 && m.refresh_ms<7650 && lut_drives==2 && power_offs==3 && resets==1);
  }
  unsigned fault_points=0;
  for(unsigned profile=1;profile<=2;++profile) {
    cold(); baseline(); current_profile=(red_lut5_profile_t)profile;
    unsigned before=spi_calls; CHECK(update(&m)==ESP_OK); const unsigned calls=spi_calls-before;
    fault_points+=calls;
    for(unsigned failure=1;failure<=calls;++failure) {
      cold(); baseline(); current_profile=(red_lut5_profile_t)profile; fail_at=spi_calls+failure;
      CHECK(update(&m)!=ESP_OK && !s_epd_baseline_valid && lut_drives<=1 && resets==1);
      before=spi_calls; CHECK(update(&m)==ESP_ERR_INVALID_STATE && spi_calls==before);
    }
  }
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
  cold(); baseline(); before=spi_calls; current_profile=(red_lut5_profile_t)3;
  CHECK(update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before);
  cold(); baseline(); before=spi_calls;
  CHECK(update(NULL)==ESP_ERR_INVALID_ARG && spi_calls==before);
  CHECK(epd_red_lut5_refresh(NULL,previous_black,previous_red,15000,128,40,RED_LUT5_FULL,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_lut5_refresh(&canvas,black,previous_red,15000,128,40,RED_LUT5_FULL,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_lut5_refresh(&canvas,previous_black,previous_red,14999,128,40,RED_LUT5_FULL,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_lut5_refresh(&canvas,previous_black,previous_red,15000,299,2,RED_LUT5_FULL,&m)==ESP_ERR_INVALID_ARG);
  CHECK(epd_red_lut5_refresh(&canvas,previous_black,previous_red,15000,0,0,RED_LUT5_FULL,&m)==ESP_ERR_INVALID_ARG);
  CHECK(spi_calls==before); red[130*50]=black[130*50]=0;
  CHECK(update(&m)==ESP_ERR_INVALID_ARG && spi_calls==before);
  printf("PASS: whole-driver SPI, explicit BWR/DDX/PLL, 5 LUTs including 0x21 after wake, 120000 pixel color routing, whole-band red removal/reappearance, outside RAM, retained state; %u transaction faults; BUSY/reset/sleep/shutdown; no optics simulated\n",fault_points);
  return 0;
}
