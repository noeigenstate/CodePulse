#include <assert.h>
#include <stdio.h>
#include "audio_pin_policy.h"
int main(void) {
  /* Synthetic only. Not an approved PCB wiring map. */
  codepulse_audio_pins_t pins={38,39,40,41,true,21,47,48};
  assert(codepulse_audio_pins_valid(&pins));
  const int blocked[]={0,4,5,6,7,8,9,10,11,12,15,16,17,18,19,20,22,25,26,35,36,37,42,49,-1};
  for(size_t i=0;i<sizeof(blocked)/sizeof(blocked[0]);++i){
    codepulse_audio_pins_t bad=pins;bad.bclk=blocked[i];assert(!codepulse_audio_pins_valid(&bad));
  }
  pins.dout=46;assert(!codepulse_audio_pins_valid(&pins));pins.dout=40;
  pins.mic_clock=pins.bclk;assert(!codepulse_audio_pins_valid(&pins));pins.mic_clock=21;
  pins.amp_enable=-1;assert(codepulse_audio_pins_valid(&pins));
  pins.input_enabled=false;pins.mic_clock=-1;pins.mic_data=-1;pins.talk_button=-1;
  assert(codepulse_audio_pins_valid(&pins));
  assert(!codepulse_audio_pins_valid(NULL));
  puts("PASS: new audio GPIO validation rejects legacy display/power/USB/ADC conflicts.");
  return 0;
}
