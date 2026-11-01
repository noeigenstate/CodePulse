#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
  uint32_t voltage_mv;
  uint8_t percent;
  int raw;
  bool calibrated;
} battery_sample_t;

/* Initializes the GPIO8 / ADC1_CH7 input used by the Board1 flywire. */
esp_err_t battery_adc_init(void);

/*
 * Reads the 200k/100k divider and returns battery voltage plus a rough
 * loaded-voltage state-of-charge estimate. battery_adc_init() must succeed
 * before this function is called.
 */
esp_err_t battery_adc_read(battery_sample_t *sample);
