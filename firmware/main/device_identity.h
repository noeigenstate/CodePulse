#pragma once

#include <stdint.h>

#include "esp_err.h"

#define CODEPULSE_DEVICE_ID_MAX_BYTES 31
#define CODEPULSE_FIRMWARE_VERSION_MAX_BYTES 31

typedef struct {
  char device_id[CODEPULSE_DEVICE_ID_MAX_BYTES + 1];
  char firmware_version[CODEPULSE_FIRMWARE_VERSION_MAX_BYTES + 1];
  uint32_t hardware_revision;
} codepulse_device_identity_t;

/* Builds the stable public identity derived from the Wi-Fi station MAC. */
esp_err_t codepulse_device_identity_read(codepulse_device_identity_t *identity);
