#include <stdio.h>
#include <string.h>
#include "test_check.h"
#include "../panel_readback.c"
static int level[18], input_mode, partial, busy_stuck, scenario;
static unsigned cmd_bits, command, current, rx_bits, otp_pass, status_reads;
static unsigned calls, fail_at, commands, reads, yields, read_bytes[2], faults;
static uint64_t clock_us;
static uint8_t otp[4096];

static int fault(void) { ++calls; return calls==fail_at; }
static void reset(void) {
  memset(level,0,sizeof(level)); level[7]=level[5]=1;
  input_mode=GPIO_MODE_INPUT_OUTPUT; partial=busy_stuck=scenario=0;
  cmd_bits=command=current=rx_bits=otp_pass=status_reads=0;
  calls=fail_at=commands=reads=yields=faults=0;clock_us=0;
  memset(read_bytes,0,sizeof(read_bytes));captured=false;
  for(unsigned i=0;i<4096;++i) otp[i]=(uint8_t)(i*37+0x69+(i>>8));
  otp[0]=0xA5;otp[1]=0x42;otp[0x20]=0xA5;otp[0x27]=0xF7;
}
static int allowed_pin(int pin) { return pin==5 || pin==6 || pin==7 || pin==16 || pin==17; }
esp_err_t gpio_set_level(int pin,int value) {
  CHECK(allowed_pin(pin) && (value==0 || value==1));
  if(fault()) { ++faults; return ESP_FAIL; }
  if(pin==7 && value!=level[7]) {
    if(value==0) {
      CHECK(level[16]==0);
      if(level[6]==0) { CHECK(input_mode==GPIO_MODE_INPUT_OUTPUT);cmd_bits=command=0; }
      else { CHECK(input_mode==GPIO_MODE_INPUT);rx_bits=0;++reads;
        CHECK(current==0x70 || current==0x71 || current==0xA2);
        if(current==0xA2) ++otp_pass;
        if(current==0x71) ++status_reads;
      }
    } else if(level[6]==0 && cmd_bits==8) {
      ++commands; current=command;
      CHECK(current==0x70 || current==0x71 || current==0x91 || current==0x92 || current==0xA2);
      if(current==0x91 && scenario!=3) partial=1;
      if(current==0x92) partial=0;
    } else if(level[6]==1) {
      if(!faults) CHECK((rx_bits&7)==0);
    }
  }
  if(pin==16 && value==1 && level[16]==0 && level[7]==0 && level[6]==0) {
    CHECK(input_mode==GPIO_MODE_INPUT_OUTPUT && cmd_bits<8);
    command=(command<<1)|(unsigned)level[17];++cmd_bits;
  }
  level[pin]=value;return ESP_OK;
}
esp_err_t gpio_set_direction(int pin,int mode) {
  CHECK(pin==17 && (mode==GPIO_MODE_INPUT || mode==GPIO_MODE_INPUT_OUTPUT));
  if(fault()) { ++faults; return ESP_FAIL; }
  /* Never enable an MCU output while the panel is selected for a read. */
  CHECK(mode==GPIO_MODE_INPUT || level[7]==1);
  input_mode=mode;return ESP_OK;
}
esp_err_t gpio_set_pull_mode(int pin,int mode) {
  CHECK(pin==17 && mode==GPIO_FLOATING);
  if(fault()) { ++faults; return ESP_FAIL; } return ESP_OK;
}
int gpio_get_level(int pin) {
  if(pin==4) return !busy_stuck;
  CHECK(pin==17 && level[7]==0 && level[6]==1 && level[16]==1 && input_mode==GPIO_MODE_INPUT);
  unsigned byte=rx_bits/8, bit=rx_bits%8; uint8_t value=0;
  if(current==0x71) {
    value=(uint8_t)(0x13|(partial?0x40:0));
    if(scenario==1) value=0xFF;
    if(scenario==2) value=0;
    if(scenario==8) value|=4;
    if(scenario==9 && status_reads==4) value^=0x08;
  } else if(current==0x70) value=scenario==7?0x43:0x42;
  else if(current==0xA2) {
    CHECK(byte<=4096 && otp_pass>=1 && otp_pass<=2);
    value=byte?otp[byte-1]:0xA7;
    if(scenario==4 && otp_pass==2 && byte==257) value^=1;
    if(scenario==5 && byte) value=0;
    if(scenario==6 && byte) value=0xFF;
    if(bit==7) ++read_bytes[otp_pass-1];
  } else CHECK(false);
  ++rx_bits;return (value>>(7-bit))&1;
}
void esp_rom_delay_us(uint32_t us) { CHECK(us==20 || us==5000);clock_us+=us; }
void vTaskDelay(TickType_t ticks) { CHECK(ticks==1 || ticks==2 || ticks==20);clock_us+=ticks*10000;++yields; }
static void safe(void) {
  CHECK(level[7]==1 && level[16]==0 && level[6]==0 && level[17]==0);
  CHECK(input_mode==GPIO_MODE_INPUT_OUTPUT && partial==0);
}
int main(void) {
  panel_readback_t result;
  reset();CHECK(panel_readback_capture(NULL)==ESP_ERR_INVALID_ARG && calls==0);
  CHECK(panel_readback_capture(&result)==ESP_OK);
  CHECK(result.link_verified && result.otp_repeatable && result.otp_nonuniform && result.revision_matches);
  CHECK(result.status_before==0x13 && result.status_partial==0x53 && result.status_after==0x13);
  CHECK(result.dummy[0]==0xA7 && result.dummy[1]==0xA7);
  CHECK(memcmp(result.otp,otp,4096)==0 && read_bytes[0]==4097 && read_bytes[1]==4097);
  CHECK(clock_us>3000000 && clock_us<5000000 && yields==66);safe();
  const unsigned full_calls=calls;
  CHECK(panel_readback_capture(&result)==ESP_ERR_INVALID_STATE && calls==full_calls);
  CHECK(!permitted(0xA0) && !permitted(0xA1) && !permitted(0x04) && !permitted(0x12));
  CHECK(send_command(0x12)==ESP_ERR_INVALID_ARG && calls==full_calls);
  for(int mode=1;mode<=9;++mode) {
    reset();scenario=mode;CHECK(panel_readback_capture(&result)==ESP_ERR_INVALID_RESPONSE);
    if(mode<=3 || mode==8) CHECK(!result.link_verified && otp_pass==0);
    if(mode==4) CHECK(result.link_verified && !result.otp_repeatable);
    if(mode==5 || mode==6) CHECK(result.otp_repeatable && !result.otp_nonuniform);
    if(mode==7) CHECK(!result.revision_matches);
    safe();
  }
  reset();busy_stuck=1;CHECK(panel_readback_capture(&result)==ESP_ERR_TIMEOUT && otp_pass==0);
  CHECK(clock_us<2500000 && commands==0);safe();
  /* Every operation around turnarounds, sampled long payload, and final cleanup.
   * Real GPIO failures must stop the read, not fall back to a refresh. */
  unsigned injected=0;
  for(unsigned at=1;at<=full_calls;++at) {
    if(at>400 && at<full_calls-300 && at%997!=0) continue;
    reset();fail_at=at;CHECK(panel_readback_capture(&result)!=ESP_OK && faults==1);
    CHECK(level[7]==1 || input_mode==GPIO_MODE_INPUT);++injected;
  }
  printf("PASS: status challenge, 2 x 4096 bytes + dummy, read turnaround, no HV/refresh/OTP writes, bounded BUSY, %u GPIO fault points\n",injected);
  return 0;
}
