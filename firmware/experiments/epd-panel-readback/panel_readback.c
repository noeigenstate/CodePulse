#include "panel_readback.h"
#include <stddef.h>
#include <string.h>
#include "board_pins.h"
#include "driver/gpio.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
/* UC8176 manual pp. 23, 26, 27, 30. SDA is bidirectional; BS remains
 * four-wire. Keep CS high during MCU output-to-input turnaround. */
#define HALF_CLOCK_US 20
#define TRY(x) do { esp_err_t e_=(x); if(e_!=ESP_OK) return e_; } while(0)
static bool captured;
static uint8_t otp_second[PANEL_OTP_BYTES];
static bool permitted(uint8_t cmd) {
  return cmd==0x70 || cmd==0x71 || cmd==0x91 || cmd==0x92 || cmd==0xA2;
}
static void pause_clock(void) { esp_rom_delay_us(HALF_CLOCK_US); }
static esp_err_t finish_transaction(void) {
  /* Stop selection before enabling the output driver. On a CS failure keep
   * SDA high impedance instead of risking contention with the panel. */
  esp_err_t err=gpio_set_level(PIN_EPD_CS,1);
  if(err!=ESP_OK) {
    (void)gpio_set_direction(PIN_EPD_MOSI,GPIO_MODE_INPUT);
    return err;
  }
  pause_clock();
  TRY(gpio_set_level(PIN_EPD_SCLK,0));
  TRY(gpio_set_level(PIN_EPD_DC,0));
  TRY(gpio_set_level(PIN_EPD_MOSI,0));
  return gpio_set_direction(PIN_EPD_MOSI,GPIO_MODE_INPUT_OUTPUT);
}
static esp_err_t send_command(uint8_t cmd) {
  if(!permitted(cmd)) return ESP_ERR_INVALID_ARG;
  TRY(finish_transaction());
  TRY(gpio_set_level(PIN_EPD_CS,0));
  for(unsigned bit=0;bit<8;++bit) {
    TRY(gpio_set_level(PIN_EPD_MOSI,(cmd>>(7-bit))&1));
    pause_clock();
    TRY(gpio_set_level(PIN_EPD_SCLK,1));
    pause_clock();
    TRY(gpio_set_level(PIN_EPD_SCLK,0));
  }
  return finish_transaction();
}
static esp_err_t read_byte(uint8_t *value) {
  unsigned data=0;
  for(unsigned bit=0;bit<8;++bit) {
    pause_clock();
    TRY(gpio_set_level(PIN_EPD_SCLK,1));
    pause_clock();
    data=(data<<1)|(gpio_get_level(PIN_EPD_MOSI)?1U:0U);
    TRY(gpio_set_level(PIN_EPD_SCLK,0));
  }
  *value=(uint8_t)data;
  return ESP_OK;
}
static esp_err_t read_data(uint8_t cmd,uint8_t *out,size_t size,uint8_t *dummy) {
  if(!out || !size || (cmd!=0x70 && cmd!=0x71 && cmd!=0xA2) ||
     ((cmd==0xA2)!=(dummy!=NULL))) return ESP_ERR_INVALID_ARG;
  TRY(send_command(cmd));
  TRY(gpio_set_direction(PIN_EPD_MOSI,GPIO_MODE_INPUT));
  TRY(gpio_set_level(PIN_EPD_DC,1));
  pause_clock();
  TRY(gpio_set_level(PIN_EPD_CS,0));
  if(dummy) TRY(read_byte(dummy));
  for(size_t i=0;i<size;++i) {
    TRY(read_byte(out+i));
    if((i&127)==127) vTaskDelay(1);
  }
  return finish_transaction();
}
static esp_err_t wait_idle(void) {
  for(unsigned i=0;i<100;++i) {
    if(gpio_get_level(PIN_EPD_BUSY)) return ESP_OK;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  return ESP_ERR_TIMEOUT;
}
static esp_err_t setup(void) {
  TRY(finish_transaction());
  TRY(gpio_set_pull_mode(PIN_EPD_MOSI,GPIO_FLOATING));
  TRY(gpio_set_level(PIN_EPD_RST,1));
  vTaskDelay(pdMS_TO_TICKS(200));
  TRY(gpio_set_level(PIN_EPD_RST,0));
  esp_rom_delay_us(5000);
  TRY(gpio_set_level(PIN_EPD_RST,1));
  vTaskDelay(pdMS_TO_TICKS(200));
  return wait_idle();
}
static bool status_safe(uint8_t status) {
  return status!=0xFF && (status&1)!=0 && (status&4)==0;
}
static esp_err_t collect(panel_readback_t *r) {
  TRY(setup());
  TRY(send_command(0x92));
  TRY(read_data(0x71,&r->status_before,1,NULL));
  if(!status_safe(r->status_before) || (r->status_before&0x40))
    return ESP_ERR_INVALID_RESPONSE;
  TRY(send_command(0x91));
  TRY(read_data(0x71,&r->status_partial,1,NULL));
  TRY(send_command(0x92));
  TRY(read_data(0x71,&r->status_after,1,NULL));
  if(!status_safe(r->status_partial) || !status_safe(r->status_after) ||
     (r->status_partial^r->status_before)!=0x40 ||
     r->status_after!=r->status_before)
    return ESP_ERR_INVALID_RESPONSE;
  r->link_verified=true;
  TRY(read_data(0x70,&r->revision,1,NULL));
  TRY(read_data(0xA2,r->otp,sizeof(r->otp),&r->dummy[0]));
  TRY(read_data(0xA2,otp_second,sizeof(otp_second),&r->dummy[1]));
  TRY(read_data(0x71,&r->status_final,1,NULL));
  r->otp_repeatable=memcmp(r->otp,otp_second,sizeof(r->otp))==0;
  for(size_t i=1;i<sizeof(r->otp);++i)
    if(r->otp[i]!=r->otp[0]) { r->otp_nonuniform=true; break; }
  r->revision_matches=r->revision==r->otp[1];
  if(!r->otp_repeatable || !r->otp_nonuniform || !r->revision_matches ||
     r->status_final!=r->status_before)
    return ESP_ERR_INVALID_RESPONSE;
  return ESP_OK;
}
esp_err_t panel_readback_capture(panel_readback_t *r) {
  if(!r) return ESP_ERR_INVALID_ARG;
  if(captured) return ESP_ERR_INVALID_STATE;
  captured=true;
  memset(r,0,sizeof(*r));
  esp_err_t result=collect(r);
  /* No read retry or display fallback. Return to non-partial logic mode. */
  esp_err_t cleanup=finish_transaction();
  if(cleanup==ESP_OK) cleanup=gpio_set_level(PIN_EPD_RST,1);
  if(cleanup==ESP_OK && gpio_get_level(PIN_EPD_BUSY)) cleanup=send_command(0x92);
  if(result==ESP_OK) result=cleanup;
  /* Also close a partial transaction if the final PARTIAL_OUT command failed.
   * If CS itself cannot be released, finish_transaction leaves SDA high-Z. */
  const esp_err_t idle=finish_transaction();
  if(result==ESP_OK) result=idle;
  return result;
}
