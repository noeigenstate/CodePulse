#include "audio_pin_policy.h"

static bool free_pin(int pin, bool output) {
  if (pin < 0 || pin > 48 || (pin >= 22 && pin <= 37)) return false;
  if (output && pin == 46) return false;
  /* Includes old battery pad GPIO42 and all present Board1 peripherals. */
  const int reserved[] = {0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 20, 42};
  for (size_t i = 0; i < sizeof(reserved)/sizeof(reserved[0]); ++i)
    if (pin == reserved[i]) return false;
  return true;
}
bool codepulse_audio_pins_valid(const codepulse_audio_pins_t *p) {
  if (!p) return false;
  const int pins[] = {p->bclk,p->ws,p->dout,p->amp_enable,p->mic_clock,p->mic_data,p->talk_button};
  const bool output[] = {true,true,true,true,true,false,false};
  const size_t count = p->input_enabled ? 7 : 4;
  for (size_t i=0;i<count;++i) {
    if (i==3 && pins[i]==-1) continue; /* Optional permanently enabled amp. */
    if (!free_pin(pins[i],output[i])) return false;
    for(size_t j=0;j<i;++j) if(pins[i]==pins[j])return false;
  }
  return true;
}
