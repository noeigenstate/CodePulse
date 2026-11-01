#pragma once

#include <stddef.h>

#include "codepulse_protocol.h"
#include "device_config.h"
#include "esp_err.h"

#define CODEPULSE_ETAG_MAX_BYTES 63

typedef enum {
  CODEPULSE_FETCH_UPDATED,
  CODEPULSE_FETCH_UNCHANGED,
} codepulse_fetch_result_t;

typedef struct {
  char etag[CODEPULSE_ETAG_MAX_BYTES + 1];
} codepulse_client_t;

void codepulse_client_init(codepulse_client_t *client);

/* Performs one authenticated conditional GET against the configured desktop. */
esp_err_t codepulse_client_fetch(const codepulse_device_config_t *config,
                                 codepulse_client_t *client,
                                 codepulse_remote_status_t *status,
                                 codepulse_fetch_result_t *result);

/* Waits at most wait_ms for a changed ETag; zero performs a normal GET.
 * The desktop may reply immediately. Only the main task owns this client. */
esp_err_t codepulse_client_watch(const codepulse_device_config_t *config,
    codepulse_client_t *client, codepulse_remote_status_t *status,
    codepulse_fetch_result_t *result, uint32_t wait_ms);
