#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "device_config.h"
#include "esp_err.h"

/* Connects in station mode and waits until DHCP supplies an IPv4 address. */
esp_err_t wifi_manager_connect(const codepulse_device_config_t *config,
                               uint32_t timeout_ms);

bool wifi_manager_is_connected(void);

/* Stops the radio and prevents the disconnect event from reconnecting. */
esp_err_t wifi_manager_stop(void);
