#include "codepulse_client.h"

#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_http_client.h"

#define CODEPULSE_STATUS_PATH "/api/v1/device/status"
#define CODEPULSE_HTTP_BODY_MAX_BYTES 32768
#define CODEPULSE_HTTP_TIMEOUT_MS 7000
#define CODEPULSE_URL_MAX_BYTES 160

typedef struct {
  char *body;
  size_t body_length;
  size_t body_capacity;
  char etag[CODEPULSE_ETAG_MAX_BYTES + 1];
  bool body_overflow;
} http_response_t;

void codepulse_client_init(codepulse_client_t *client) {
  if (client != NULL) {
    memset(client, 0, sizeof(*client));
  }
}

static esp_err_t http_event_handler(esp_http_client_event_t *event) {
  http_response_t *response = (http_response_t *)event->user_data;
  if (response == NULL) {
    return ESP_ERR_INVALID_ARG;
  }

  if (event->event_id == HTTP_EVENT_ON_HEADER && event->header_key != NULL &&
      event->header_value != NULL &&
      strcasecmp(event->header_key, "etag") == 0) {
    const size_t length = strlen(event->header_value);
    if (length <= CODEPULSE_ETAG_MAX_BYTES) {
      memcpy(response->etag, event->header_value, length + 1);
    }
    return ESP_OK;
  }

  if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
    const size_t incoming = (size_t)event->data_len;
    if (response->body_length + incoming > response->body_capacity) {
      response->body_overflow = true;
      return ESP_ERR_INVALID_SIZE;
    }
    memcpy(response->body + response->body_length, event->data, incoming);
    response->body_length += incoming;
    response->body[response->body_length] = '\0';
  }

  return ESP_OK;
}

static void update_etag(codepulse_client_t *client,
                        const http_response_t *response,
                        const codepulse_remote_status_t *status) {
  if (response->etag[0] != '\0') {
    memcpy(client->etag, response->etag, strlen(response->etag) + 1);
    return;
  }
  snprintf(client->etag, sizeof(client->etag), "W/\"%s\"", status->revision);
}

esp_err_t codepulse_client_watch(const codepulse_device_config_t *config,
                                 codepulse_client_t *client,
                                 codepulse_remote_status_t *status,
                                 codepulse_fetch_result_t *result, uint32_t wait_ms) {
  if (config == NULL || client == NULL || status == NULL || result == NULL) {
    return ESP_ERR_INVALID_ARG;
  }

  if (wait_ms > 1000) return ESP_ERR_INVALID_ARG;
  char url[CODEPULSE_URL_MAX_BYTES];
  const int url_length =
      snprintf(url, sizeof(url), "http://%s:%u%s", config->server_host,
               (unsigned int)config->server_port, CODEPULSE_STATUS_PATH);
  if (url_length < 0 || (size_t)url_length >= sizeof(url)) {
    return ESP_ERR_INVALID_SIZE;
  }

  char *body = calloc(CODEPULSE_HTTP_BODY_MAX_BYTES + 1, 1);
  if (body == NULL) {
    return ESP_ERR_NO_MEM;
  }
  http_response_t response = {
      .body = body,
      .body_capacity = CODEPULSE_HTTP_BODY_MAX_BYTES,
  };
  const esp_http_client_config_t http_config = {
      .url = url,
      .event_handler = http_event_handler,
      .user_data = &response,
      .timeout_ms = CODEPULSE_HTTP_TIMEOUT_MS,
      .buffer_size = 1024,
      .buffer_size_tx = 512,
      .disable_auto_redirect = true,
      .keep_alive_enable = false,
  };

  esp_http_client_handle_t http = esp_http_client_init(&http_config);
  if (http == NULL) {
    free(body);
    return ESP_ERR_NO_MEM;
  }

  esp_err_t err = esp_http_client_set_header(http, "X-CodePulse-Device-Token",
                                             config->device_token);
  if (err == ESP_OK && client->etag[0] != '\0') {
    err = esp_http_client_set_header(http, "If-None-Match", client->etag);
  }
  if (err == ESP_OK) {
    char wait[12];
    snprintf(wait, sizeof(wait), "%" PRIu32, wait_ms);
    err = esp_http_client_set_header(http, "X-CodePulse-Wait-Ms", wait);
  }
  if (err == ESP_OK) {
    err = esp_http_client_perform(http);
  }

  const int status_code = esp_http_client_get_status_code(http);
  esp_http_client_cleanup(http);

  if (err != ESP_OK) {
    free(body);
    return err;
  }
  if (response.body_overflow) {
    free(body);
    return ESP_ERR_INVALID_SIZE;
  }

  if (status_code == 304) {
    if (response.etag[0] != '\0') {
      memcpy(client->etag, response.etag, strlen(response.etag) + 1);
    }
    *result = CODEPULSE_FETCH_UNCHANGED;
    free(body);
    return ESP_OK;
  }

  if (status_code != 200) {
    free(body);
    return ESP_ERR_INVALID_RESPONSE;
  }
  if (response.body_length == 0) {
    free(body);
    return ESP_ERR_INVALID_RESPONSE;
  }

  /* Parser commits atomically on success; avoid another large stack copy. */
  err = codepulse_protocol_parse(response.body, response.body_length, status);
  if (err == ESP_OK) {
    update_etag(client, &response, status);
    *result = CODEPULSE_FETCH_UPDATED;
  }

  free(body);
  return err;
}

esp_err_t codepulse_client_fetch(const codepulse_device_config_t *config,
    codepulse_client_t *client, codepulse_remote_status_t *status,
    codepulse_fetch_result_t *result) {
  return codepulse_client_watch(config, client, status, result, 0);
}
