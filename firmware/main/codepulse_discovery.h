#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "device_config.h"
#include "esp_err.h"

#define CODEPULSE_DESKTOP_MDNS_SERVICE_TYPE "_codepulse"
#define CODEPULSE_DISPLAY_MDNS_SERVICE_TYPE "_codepulse-dsp"
#define CODEPULSE_MDNS_PROTOCOL "_tcp"
#define CODEPULSE_DISPLAY_HEALTH_PORT 17890
#define CODEPULSE_DISPLAY_HEALTH_PATH "/api/v1/device/health"

typedef struct {
  char host[CODEPULSE_SERVER_HOST_MAX_BYTES + 1];
  uint16_t port;
  bool discovered;
} codepulse_server_endpoint_t;

/* Starts mDNS and the read-only display health service after Wi-Fi connects. */
esp_err_t codepulse_discovery_start(void);

/* Stops the display health service, mDNS responder, and cached endpoint. */
void codepulse_discovery_stop(void);

/* Resolves the paired desktop by TXT id, with the configured host as fallback.
 */
esp_err_t codepulse_discovery_resolve(const codepulse_device_config_t *config,
                                      uint32_t timeout_ms,
                                      codepulse_server_endpoint_t *endpoint);

/* Invalidates a discovered address after a request failure. */
void codepulse_discovery_invalidate(void);

/* Remember an endpoint only after a successful authenticated HTTP response. */
void codepulse_discovery_remember(const codepulse_device_config_t *config,
                                  const codepulse_server_endpoint_t *endpoint);
