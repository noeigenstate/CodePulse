#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "nvs.h"

#define CODEPULSE_WIFI_SSID_MAX_BYTES 32
#define CODEPULSE_WIFI_PASSWORD_MAX_BYTES 64
#define CODEPULSE_SERVER_ID_MAX_BYTES 64
#define CODEPULSE_SERVER_HOST_MAX_BYTES 63
#define CODEPULSE_DEVICE_TOKEN_MAX_BYTES 128
#define CODEPULSE_DEVICE_TOKEN_MIN_BYTES 16
#define CODEPULSE_DEFAULT_DEVICE_API_PORT 17889

typedef struct {
  char wifi_ssid[CODEPULSE_WIFI_SSID_MAX_BYTES + 1];
  char wifi_password[CODEPULSE_WIFI_PASSWORD_MAX_BYTES + 1];
  char server_id[CODEPULSE_SERVER_ID_MAX_BYTES + 1];
  char server_host[CODEPULSE_SERVER_HOST_MAX_BYTES + 1];
  uint16_t server_port;
  char device_token[CODEPULSE_DEVICE_TOKEN_MAX_BYTES + 1];
} codepulse_device_config_t;

/* Initializes the default NVS partition without erasing existing settings. */
esp_err_t codepulse_device_config_init(void);

/*
 * Loads the provisioned network settings from the "codepulse" NVS namespace.
 * Returns ESP_ERR_NVS_NOT_FOUND when the board has not been provisioned.
 */
esp_err_t codepulse_device_config_load(codepulse_device_config_t *config);

/* Validates a complete configuration without reading or writing NVS. */
esp_err_t
codepulse_device_config_validate(const codepulse_device_config_t *config);

/* Atomically commits one validated configuration to the dedicated namespace. */
esp_err_t codepulse_device_config_save(const codepulse_device_config_t *config);
