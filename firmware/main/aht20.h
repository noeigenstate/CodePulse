#pragma once

#include "esp_err.h"

typedef struct {
  float temperature_c;
  float humidity_rh;
} aht20_sample_t;

/* Initializes the Board1 I2C bus and verifies the AHT20 at address 0x38. */
esp_err_t aht20_init(void);

/* Triggers one CRC-checked measurement. The total timeout is bounded. */
esp_err_t aht20_read(aht20_sample_t *sample);
