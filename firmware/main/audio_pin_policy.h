#pragma once
#include <stdbool.h>
#include <stddef.h>

typedef struct {
  int bclk, ws, dout, amp_enable;
  bool input_enabled;
  int mic_clock, mic_data, talk_button;
} codepulse_audio_pins_t;

/* Current EPD/power/USB/ADC pins are reserved. A future netlist must be checked explicitly. */
bool codepulse_audio_pins_valid(const codepulse_audio_pins_t *pins);
