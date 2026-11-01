#include "codepulse_discovery.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "device_identity.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "mdns.h"

#define CODEPULSE_MDNS_PROTOCOL_VERSION "1"
#define CODEPULSE_MDNS_MAX_RESULTS 8

static const char *TAG = "codepulse_mdns";
static bool s_mdns_ready;
static httpd_handle_t s_health_server;
static char s_cached_server_id[CODEPULSE_SERVER_ID_MAX_BYTES + 1];
static codepulse_server_endpoint_t s_cached_endpoint;

static void secure_zero(void *memory, size_t length) {
  volatile unsigned char *cursor = (volatile unsigned char *)memory;
  while (length-- > 0) {
    *cursor++ = 0;
  }
}

static esp_err_t health_handler(httpd_req_t *request) {
  codepulse_device_identity_t identity;
  const esp_err_t identity_err = codepulse_device_identity_read(&identity);
  if (identity_err != ESP_OK) {
    httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR,
                        "identity unavailable");
    return identity_err;
  }

  codepulse_device_config_t config;
  const bool provisioned = codepulse_device_config_load(&config) == ESP_OK;
  secure_zero(&config, sizeof(config));

  cJSON *body = cJSON_CreateObject();
  if (body == NULL) {
    httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR,
                        "out of memory");
    return ESP_ERR_NO_MEM;
  }
  cJSON_AddBoolToObject(body, "ok", true);
  cJSON_AddStringToObject(body, "service", "codepulse-display");
  cJSON_AddNumberToObject(body, "protocolVersion", 1);
  cJSON_AddStringToObject(body, "deviceId", identity.device_id);
  cJSON_AddStringToObject(body, "firmwareVersion", identity.firmware_version);
  cJSON_AddNumberToObject(body, "hardwareRevision", identity.hardware_revision);
  cJSON_AddBoolToObject(body, "provisioned", provisioned);

  char *encoded = cJSON_PrintUnformatted(body);
  cJSON_Delete(body);
  if (encoded == NULL) {
    httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR,
                        "out of memory");
    return ESP_ERR_NO_MEM;
  }

  httpd_resp_set_type(request, "application/json; charset=utf-8");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  const esp_err_t err = httpd_resp_sendstr(request, encoded);
  cJSON_free(encoded);
  return err;
}

static esp_err_t start_health_server(void) {
  if (s_health_server != NULL) {
    return ESP_OK;
  }

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = CODEPULSE_DISPLAY_HEALTH_PORT;
  config.stack_size = 4096;
  config.max_uri_handlers = 2;
  config.lru_purge_enable = true;
  esp_err_t err = httpd_start(&s_health_server, &config);
  if (err != ESP_OK) {
    s_health_server = NULL;
    return err;
  }

  const httpd_uri_t health_uri = {
      .uri = CODEPULSE_DISPLAY_HEALTH_PATH,
      .method = HTTP_GET,
      .handler = health_handler,
  };
  err = httpd_register_uri_handler(s_health_server, &health_uri);
  if (err != ESP_OK) {
    httpd_stop(s_health_server);
    s_health_server = NULL;
  }
  return err;
}

static esp_err_t
advertise_display_service(const codepulse_device_identity_t *identity) {
  char hardware_revision[12];
  snprintf(hardware_revision, sizeof(hardware_revision), "%" PRIu32,
           identity->hardware_revision);
  mdns_txt_item_t txt[] = {
      {.key = "pv", .value = CODEPULSE_MDNS_PROTOCOL_VERSION},
      {.key = "id", .value = identity->device_id},
      {.key = "fw", .value = identity->firmware_version},
      {.key = "hw", .value = hardware_revision},
      {.key = "path", .value = CODEPULSE_DISPLAY_HEALTH_PATH},
  };
  return mdns_service_add(
      identity->device_id, CODEPULSE_DISPLAY_MDNS_SERVICE_TYPE,
      CODEPULSE_MDNS_PROTOCOL, CODEPULSE_DISPLAY_HEALTH_PORT, txt,
      sizeof(txt) / sizeof(txt[0]));
}

esp_err_t codepulse_discovery_start(void) {
  codepulse_device_identity_t identity;
  esp_err_t err = codepulse_device_identity_read(&identity);
  if (err != ESP_OK) {
    return err;
  }

  if (!s_mdns_ready) {
    err = mdns_init();
    if (err != ESP_OK) {
      return err;
    }
    s_mdns_ready = true;

    err = mdns_hostname_set(identity.device_id);
    if (err != ESP_OK) {
      codepulse_discovery_stop();
      return err;
    }
    err = mdns_instance_name_set(identity.device_id);
    if (err != ESP_OK) {
      codepulse_discovery_stop();
      return err;
    }
  }

  const esp_err_t health_err = start_health_server();
  if (health_err != ESP_OK) {
    ESP_LOGW(TAG, "display health server failed: %s",
             esp_err_to_name(health_err));
  } else if (!mdns_service_exists(CODEPULSE_DISPLAY_MDNS_SERVICE_TYPE,
                                  CODEPULSE_MDNS_PROTOCOL, NULL)) {
    const esp_err_t advertise_err = advertise_display_service(&identity);
    if (advertise_err == ESP_OK) {
      ESP_LOGI(TAG, "advertising %s.%s on port %u device_id=%s",
               CODEPULSE_DISPLAY_MDNS_SERVICE_TYPE, CODEPULSE_MDNS_PROTOCOL,
               CODEPULSE_DISPLAY_HEALTH_PORT, identity.device_id);
    } else {
      ESP_LOGW(TAG, "display mDNS advertisement failed: %s",
               esp_err_to_name(advertise_err));
    }
  }

  return ESP_OK;
}

void codepulse_discovery_stop(void) {
  if (s_health_server != NULL) {
    httpd_stop(s_health_server);
    s_health_server = NULL;
  }
  if (s_mdns_ready) {
    mdns_free();
  }
  s_mdns_ready = false;
  codepulse_discovery_invalidate();
}

static bool txt_equals(const mdns_result_t *result, const char *key,
                       const char *expected) {
  if (result->txt == NULL || result->txt_value_len == NULL) {
    return false;
  }
  const size_t expected_length = strlen(expected);
  for (size_t index = 0; index < result->txt_count; ++index) {
    if (result->txt[index].key != NULL &&
        strcmp(result->txt[index].key, key) == 0 &&
        result->txt[index].value != NULL &&
        result->txt_value_len[index] == expected_length &&
        memcmp(result->txt[index].value, expected, expected_length) == 0) {
      return true;
    }
  }
  return false;
}

static bool result_ipv4(const mdns_result_t *result, char *host,
                        size_t capacity) {
  for (const mdns_ip_addr_t *address = result->addr; address != NULL;
       address = address->next) {
    if (address->addr.type != ESP_IPADDR_TYPE_V4) {
      continue;
    }
    const int length =
        snprintf(host, capacity, IPSTR, IP2STR(&address->addr.u_addr.ip4));
    return length > 0 && (size_t)length < capacity;
  }
  return false;
}

static bool query_result_endpoint(const mdns_result_t *result,
                                  const char *server_id,
                                  codepulse_server_endpoint_t *endpoint) {
  if (result->port == 0 ||
      !txt_equals(result, "pv", CODEPULSE_MDNS_PROTOCOL_VERSION) ||
      !txt_equals(result, "id", server_id)) {
    return false;
  }

  char host[sizeof(endpoint->host)] = {0};
  if (!result_ipv4(result, host, sizeof(host)) && result->hostname != NULL) {
    esp_ip4_addr_t address = {0};
    if (mdns_query_a(result->hostname, 1000, &address) == ESP_OK) {
      const int length = snprintf(host, sizeof(host), IPSTR, IP2STR(&address));
      if (length <= 0 || (size_t)length >= sizeof(host)) {
        host[0] = '\0';
      }
    }
  }
  if (host[0] == '\0') {
    return false;
  }

  memcpy(endpoint->host, host, strlen(host) + 1);
  endpoint->port = result->port;
  endpoint->discovered = true;
  return true;
}

static esp_err_t fallback_endpoint(const codepulse_device_config_t *config,
                                   codepulse_server_endpoint_t *endpoint) {
  if (config->server_host[0] == '\0') {
    return ESP_ERR_NOT_FOUND;
  }
  memcpy(endpoint->host, config->server_host, strlen(config->server_host) + 1);
  endpoint->port = config->server_port;
  endpoint->discovered = false;
  return ESP_OK;
}

esp_err_t codepulse_discovery_resolve(const codepulse_device_config_t *config,
                                      uint32_t timeout_ms,
                                      codepulse_server_endpoint_t *endpoint) {
  if (config == NULL || endpoint == NULL || timeout_ms == 0) {
    return ESP_ERR_INVALID_ARG;
  }
  memset(endpoint, 0, sizeof(*endpoint));

  if (config->server_id[0] == '\0') {
    return fallback_endpoint(config, endpoint);
  }
  if (s_cached_endpoint.host[0] != '\0' &&
      strcmp(s_cached_server_id, config->server_id) == 0) {
    *endpoint = s_cached_endpoint;
    return ESP_OK;
  }
  if (!s_mdns_ready) {
    return fallback_endpoint(config, endpoint);
  }

  mdns_result_t *results = NULL;
  const esp_err_t query_err = mdns_query_ptr(
      CODEPULSE_DESKTOP_MDNS_SERVICE_TYPE, CODEPULSE_MDNS_PROTOCOL, timeout_ms,
      CODEPULSE_MDNS_MAX_RESULTS, &results);
  if (query_err == ESP_OK) {
    for (const mdns_result_t *result = results; result != NULL;
         result = result->next) {
      if (query_result_endpoint(result, config->server_id, endpoint)) {
        memcpy(s_cached_server_id, config->server_id,
               strlen(config->server_id) + 1);
        s_cached_endpoint = *endpoint;
        ESP_LOGI(TAG, "paired desktop discovered at %s:%u", endpoint->host,
                 (unsigned int)endpoint->port);
        break;
      }
    }
  }
  mdns_query_results_free(results);

  if (endpoint->host[0] != '\0') {
    return ESP_OK;
  }
  if (query_err != ESP_OK) {
    ESP_LOGW(TAG, "desktop mDNS query failed: %s", esp_err_to_name(query_err));
  } else {
    ESP_LOGW(TAG, "paired desktop id was not found through mDNS");
  }
  return fallback_endpoint(config, endpoint);
}

void codepulse_discovery_invalidate(void) {
  memset(s_cached_server_id, 0, sizeof(s_cached_server_id));
  memset(&s_cached_endpoint, 0, sizeof(s_cached_endpoint));
}

void codepulse_discovery_remember(const codepulse_device_config_t *config,
                                  const codepulse_server_endpoint_t *endpoint) {
  if (!config || !endpoint || !endpoint->host[0]) return;
  memcpy(s_cached_server_id, config->server_id, sizeof(s_cached_server_id));
  s_cached_endpoint = *endpoint;
}
