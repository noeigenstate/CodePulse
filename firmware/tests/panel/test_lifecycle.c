/* Execute the real complete panel driver against a transport/controller model.
 * This verifies lifecycle and transmitted pixels, not electrophoretic optics. */
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "panel_host.h"
#include "../../main/epd_ssd1683.c"

static int64_t fake_us, busy_until;
static int dc, resets, spi_calls, fail_at, clean_drives, quiet_drives, power_offs;
static uint8_t command, psr, calibration_marker;
static size_t window_offset, cursor, window_size, window_row_bytes=50;
static uint8_t old_ram[15000], new_ram[15000], optical_target[15000];
static uint8_t black[15000], red[15000], previous[15000];
static bool compare_pixels;
static epd_canvas_t canvas={black,red};

int64_t esp_timer_get_time(void) { return fake_us; }
void vTaskDelay(int ticks) { fake_us+=(int64_t)ticks*10000; }
void esp_rom_delay_us(uint32_t us) { fake_us+=us; }
int gpio_get_level(int pin) { assert(pin==PIN_EPD_BUSY);return fake_us>=busy_until; }
void gpio_set_level(int pin,int level) {
  if(pin==PIN_EPD_DC) dc=level;
  else if(pin==PIN_EPD_RST && !level) {
    ++resets;psr=0x0F;calibration_marker=0;window_offset=0;window_size=15000;window_row_bytes=50;
    memset(old_ram,255,sizeof(old_ram));memset(new_ram,255,sizeof(new_ram));
  }
}
esp_err_t spi_bus_initialize(int host,const spi_bus_config_t *cfg,int dma) {
  assert(host==SPI2_HOST && cfg->miso_io_num==-1 && dma==SPI_DMA_CH_AUTO);return ESP_OK;
}
esp_err_t spi_bus_add_device(int host,const spi_device_interface_config_t *cfg,spi_device_handle_t *out) {
  assert(host==SPI2_HOST && cfg->clock_speed_hz==2000000);*out=(void*)1;return ESP_OK;
}
esp_err_t spi_bus_free(int host) { assert(host==SPI2_HOST);return ESP_OK; }
esp_err_t spi_device_polling_transmit(spi_device_handle_t dev,spi_transaction_t *tx) {
  assert(dev && tx->length%8==0);++spi_calls;fake_us+=100;
  if(spi_calls==fail_at) return ESP_FAIL;
  const uint8_t *data=tx->tx_buffer;size_t len=tx->length/8;
  if(!dc) {
    assert(len==1);command=*data;cursor=0;
    assert(command!=0x01 && command!=0x82 && command!=0xA0 && command!=0xA1);
    if(command==0x04) busy_until=fake_us+30000;
    if(command==0x02) {++power_offs;busy_until=fake_us+30000;}
    if(command==0x12) {
      if(psr==0x0F) {
        ++clean_drives;calibration_marker=0x51;
        assert(!memcmp(old_ram,black,sizeof(black)) && !memcmp(new_ram,red,sizeof(red)));
        memcpy(optical_target,black,sizeof(optical_target));
      }
      else {
        assert(psr==0x3F && calibration_marker==0x51);++quiet_drives;
        if(compare_pixels) {
          for(size_t i=0;i<window_size;i++) {
            const size_t at=window_offset+(i/window_row_bytes)*50u+i%window_row_bytes;
            assert(old_ram[at]==optical_target[at] && new_ram[at]==black[at]);
          }
        }
      }
      busy_until=fake_us+130000;
    }
    return ESP_OK;
  }
  if(command==0x00) {assert(len==1);psr=data[0];}
  if(command==0x90) {
    assert(len==9);
    const unsigned first_x=data[0]*256u+data[1], last_x=data[2]*256u+data[3];
    const unsigned first_y=data[4]*256u+data[5], last_y=data[6]*256u+data[7];
    assert(first_x%8==0 && last_x%8==7 && first_x<last_x && last_x<400 && first_y<=last_y && last_y<300);
    window_offset=first_y*50u+first_x/8;
    window_row_bytes=(last_x-first_x+1)/8;
    window_size=(last_y-first_y+1)*window_row_bytes;
    assert(window_offset+window_size<=15000 && !data[8]);
  }
  if(command==0x30) assert(len==1 && data[0]==0x3A);
  if(command==0x10 || command==0x13) {
    assert(cursor+len<=window_size);
    for(size_t i=0;i<len;i++,cursor++) {
      const size_t at=window_offset+(cursor/window_row_bytes)*50u+cursor%window_row_bytes;
      assert(at<15000);
      (command==0x10?old_ram:new_ram)[at]=data[i];
    }
  }
  return ESP_OK;
}
static void cold(void) {
  fake_us=busy_until=0;dc=resets=spi_calls=fail_at=clean_drives=quiet_drives=power_offs=0;
  psr=0x0F;calibration_marker=0;window_offset=0;window_size=15000;window_row_bytes=50;compare_pixels=false;
  s_spi=NULL;s_epd_baseline_valid=false;
  memset(black,0xAA,sizeof(black));memset(red,255,sizeof(red));
  memcpy(previous,black,sizeof(previous));memcpy(optical_target,black,sizeof(optical_target));
  assert(epd_ssd1683_init()==ESP_OK);
}
static void baseline(void) {
  uint32_t duration;
  assert(epd_ssd1683_refresh(&canvas,&duration)==ESP_OK);
  assert(s_epd_baseline_valid && resets==1 && clean_drives==1 && power_offs==1);
  assert(calibration_marker==0x51);
}
int main(void) {
  epd_quiet_metrics_t m;
  cold();
  assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)==ESP_ERR_INVALID_STATE);
  assert(!spi_calls && !resets);
  baseline();compare_pixels=true;
  const unsigned windows[][2]={{0,1},{281,9},{85,23},{96,40},{38,217},{0,300},{299,1}};
  for(unsigned step=0;step<42;step++) {
    unsigned y=windows[step%7][0],h=windows[step%7][1];
    for(unsigned i=y*50;i<(y+h)*50;i++) black[i]^=(uint8_t)(step+1);
    assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),y,h,&m)==ESP_OK);
    assert(s_epd_baseline_valid && resets==1 && clean_drives==1 && calibration_marker==0x51);
    assert(quiet_drives==(int)step+1 && power_offs==(int)step+2);
    memcpy(previous,black,sizeof(previous));memcpy(optical_target,black,sizeof(optical_target));
  }
#if defined(CODEPULSE_QUIET_RECT_TRIAL) && CODEPULSE_QUIET_RECT_TRIAL
  for(unsigned step=0;step<42;step++) {
    const unsigned first=(step*7u)%49u,last=first+(step%3);
    const unsigned end=last>49?49:last;
    for(unsigned row=85;row<108;row++)for(unsigned col=first;col<=end;col++)black[row*50u+col]^=0xA5;
    assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),85,23,&m)==ESP_OK);
    assert(m.width<=32 && m.width>=16 && resets==1 && clean_drives==1 && s_epd_baseline_valid);
    memcpy(previous,black,sizeof(previous));memcpy(optical_target,black,sizeof(optical_target));
  }
#endif
  /* A runtime BWR round trip transmits actual color, then rebuilds a clean BW
   * session for the next quiet update. The quiet red guard stays mandatory. */
  uint32_t duration;
  red[100*50+17]=0x3f;black[100*50+17]|=0xc0;
  assert(epd_ssd1683_refresh(&canvas,&duration)==ESP_OK && s_epd_baseline_valid);
  assert(resets==2 && clean_drives==2 && !memcmp(new_ram,red,sizeof(red)));
  int before=spi_calls;
  assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),100,1,&m)==ESP_ERR_INVALID_ARG);
  assert(spi_calls==before && s_epd_baseline_valid);
  memset(red,255,sizeof(red));
  assert(epd_ssd1683_refresh(&canvas,&duration)==ESP_OK && s_epd_baseline_valid);
  assert(resets==3 && clean_drives==3);
  for(size_t i=0;i<sizeof(red);i++) assert(new_ram[i]==255);
  memcpy(previous,black,sizeof(previous));black[100*50+17]^=0x20;
  assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),100,1,&m)==ESP_OK);
  assert(resets==3 && s_epd_baseline_valid);
  assert(epd_ssd1683_deep_sleep()==ESP_OK && !s_epd_baseline_valid);
  before=spi_calls;
  assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)==ESP_ERR_INVALID_STATE);
  assert(spi_calls==before);
  cold();baseline();epd_hardware_reset();assert(!s_epd_baseline_valid);
  before=spi_calls;
  assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)==ESP_ERR_INVALID_STATE);
  assert(spi_calls==before);
  cold();baseline();busy_until=fake_us+30000;before=spi_calls;
  assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)==ESP_ERR_INVALID_STATE);
  assert(spi_calls==before && !s_epd_baseline_valid);
  cold();baseline();before=spi_calls;
  assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)==ESP_OK);
  int quiet_calls=spi_calls-before;
  for(int fault=1;fault<=quiet_calls;fault++) {
    cold();baseline();fail_at=spi_calls+fault;
    assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)!=ESP_OK);
    assert(!s_epd_baseline_valid);before=spi_calls;
    assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)==ESP_ERR_INVALID_STATE);
    assert(spi_calls==before);
  }
  cold();red[17]=0x7f;black[17]|=0x80;
  assert(epd_ssd1683_refresh(&canvas,&duration)==ESP_OK);
  const int full_calls=spi_calls;
  for(int fault=1;fault<=full_calls;fault++) {
    cold();red[17]=0x7f;black[17]|=0x80;fail_at=fault;
    assert(epd_ssd1683_refresh(&canvas,&duration)!=ESP_OK && !s_epd_baseline_valid);
    assert(!quiet_drives && dc==0);
    memset(red,255,sizeof(red));before=spi_calls;
    assert(epd_quiet_refresh(&canvas,previous,sizeof(previous),96,40,&m)==ESP_ERR_INVALID_STATE);
    assert(spi_calls==before);
  }
  printf("PASS: real driver baseline guard, 42 consecutive OLD/NEW windows, retained controller state, runtime BWR red/clear/BW chain, red guard, per-refresh HV off, sleep/reset/BUSY/fault invalidation; %d full-transfer fault points; no optics simulated\n",full_calls);
  return 0;
}
