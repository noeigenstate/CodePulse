#include "device_config.h"

#include <ctype.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#include "nvs.h"
#include "nvs_flash.h"

#define DEVICE_CONFIG_NAMESPACE "codepulse"
#define DEVICE_CONFIG_KEY_WIFI_SSID "wifi_ssid"
#define DEVICE_CONFIG_KEY_WIFI_PASSWORD "wifi_pass"
#define DEVICE_CONFIG_KEY_SERVER_ID "server_id"
#define DEVICE_CONFIG_KEY_SERVER_HOST "server_host"
#define DEVICE_CONFIG_KEY_SERVER_PORT "server_port"
#define DEVICE_CONFIG_KEY_DEVICE_TOKEN "device_token"
#define DEVICE_CONFIG_KEY_VERSION "config_ver"
#define DEVICE_CONFIG_VERSION 1

static bool s_nvs_ready;

esp_err_t codepulse_device_config_init(void) {
  if (s_nvs_ready) {
    return ESP_OK;
  }

  const esp_err_t err = nvs_flash_init();
  if (err == ESP_OK) {
    s_nvs_ready = true;
  }
  return err;
}

static esp_err_t load_string(nvs_handle_t handle, const char *key,
                             char *destination, size_t capacity) {
  size_t required = capacity;
  const esp_err_t err = nvs_get_str(handle, key, destination, &required);
  if (err != ESP_OK) {
    return err;
  }
  if (required == 0 || required > capacity ||
      destination[required - 1] != '\0') {
    return ESP_ERR_INVALID_SIZE;
  }
  return ESP_OK;
}

static esp_err_t load_optional_string(nvs_handle_t handle, const char *key,
                                      char *destination, size_t capacity) {
  const esp_err_t err = load_string(handle, key, destination, capacity);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    destination[0] = '\0';
    return ESP_OK;
  }
  return err;
}

static bool bounded_length(const char *value, size_t capacity, size_t *length) {
  const size_t found = strnlen(value, capacity);
  if (found == capacity) {
    return false;
  }
  *length = found;
  return true;
}

static bool is_hex_string(const char *value, size_t length) {
  for (size_t index = 0; index < length; ++index) {
    if (!isxdigit((unsigned char)value[index])) {
      return false;
    }
  }
  return true;
}

static bool is_server_id(const char *value, size_t length) {
  for (size_t index = 0; index < length; ++index) {
    const unsigned char character = (unsigned char)value[index];
    if (!isalnum(character) && character != '-' && character != '_' &&
        character != '.') {
      return false;
    }
  }
  return true;
}

static bool is_plain_host(const char *value, size_t length) {
  for (size_t index = 0; index < length; ++index) {
    const unsigned char character = (unsigned char)value[index];
    if (character <= 0x20 || character >= 0x7f || character == '/' ||
        character == ':' || character == '?' || character == '#') {
      return false;
    }
  }
  return true;
}

static bool is_header_token(const char *value, size_t length) {
  for (size_t index = 0; index < length; ++index) {
    const unsigned char character = (unsigned char)value[index];
    if (character <= 0x20 || character >= 0x7f) {
      return false;
    }
  }
  return true;
}

esp_err_t
codepulse_device_config_validate(const codepulse_device_config_t *config) {
  if (config == NULL) {
    return ESP_ERR_INVALID_ARG;
  }

  size_t ssid_length = 0;
  size_t password_length = 0;
  size_t server_id_length = 0;
  size_t host_length = 0;
  size_t token_length = 0;
  if (!bounded_length(config->wifi_ssid, sizeof(config->wifi_ssid),
                      &ssid_length) ||
      !bounded_length(config->wifi_password, sizeof(config->wifi_password),
                      &password_length) ||
      !bounded_length(config->server_id, sizeof(config->server_id),
                      &server_id_length) ||
      !bounded_length(config->server_host, sizeof(config->server_host),
                      &host_length) ||
      !bounded_length(config->device_token, sizeof(config->device_token),
                      &token_length)) {
    return ESP_ERR_INVALID_SIZE;
  }

  if (ssid_length == 0 || ssid_length > CODEPULSE_WIFI_SSID_MAX_BYTES ||
      password_length > CODEPULSE_WIFI_PASSWORD_MAX_BYTES ||
      (password_length > 0 && password_length < 8) ||
      (password_length == 64 &&
       !is_hex_string(config->wifi_password, password_length)) ||
      server_id_length > CODEPULSE_SERVER_ID_MAX_BYTES ||
      (server_id_length > 0 &&
       !is_server_id(config->server_id, server_id_length)) ||
      host_length > CODEPULSE_SERVER_HOST_MAX_BYTES ||
      (host_length > 0 && !is_plain_host(config->server_host, host_length)) ||
      (server_id_length == 0 && host_length == 0) || config->server_port == 0 ||
      token_length < CODEPULSE_DEVICE_TOKEN_MIN_BYTES ||
      token_length > CODEPULSE_DEVICE_TOKEN_MAX_BYTES ||
      !is_header_token(config->device_token, token_length)) {
    return ESP_ERR_INVALID_ARG;
  }

  return ESP_OK;
}

esp_err_t codepulse_device_config_load(codepulse_device_config_t *config) {
  if (config == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  memset(config, 0, sizeof(*config));

  esp_err_t err = codepulse_device_config_init();
  if (err != ESP_OK) {
    return err;
  }

  nvs_handle_t handle = 0;
  err = nvs_open(DEVICE_CONFIG_NAMESPACE, NVS_READONLY, &handle);
  if (err != ESP_OK) {
    return err;
  }

  err = load_string(handle, DEVICE_CONFIG_KEY_WIFI_SSID, config->wifi_ssid,
                    sizeof(config->wifi_ssid));
  if (err == ESP_OK) {
    err = load_string(handle, DEVICE_CONFIG_KEY_WIFI_PASSWORD,
                      config->wifi_password, sizeof(config->wifi_password));
  }
  if (err == ESP_OK) {
    err = load_optional_string(handle, DEVICE_CONFIG_KEY_SERVER_ID,
                               config->server_id, sizeof(config->server_id));
  }
  if (err == ESP_OK) {
    err =
        load_optional_string(handle, DEVICE_CONFIG_KEY_SERVER_HOST,
                             config->server_host, sizeof(config->server_host));
  }
  if (err == ESP_OK) {
    err = nvs_get_u16(handle, DEVICE_CONFIG_KEY_SERVER_PORT,
                      &config->server_port);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
      config->server_port = CODEPULSE_DEFAULT_DEVICE_API_PORT;
      err = ESP_OK;
    }
  }
  if (err == ESP_OK) {
    err = load_string(handle, DEVICE_CONFIG_KEY_DEVICE_TOKEN,
                      config->device_token, sizeof(config->device_token));
  }
  nvs_close(handle);

  if (err != ESP_OK) {
    memset(config, 0, sizeof(*config));
    return err;
  }

  err = codepulse_device_config_validate(config);
  if (err != ESP_OK) {
    memset(config, 0, sizeof(*config));
    return err;
  }

  return ESP_OK;
}

esp_err_t
codepulse_device_config_save(const codepulse_device_config_t *config) {
  esp_err_t err = codepulse_device_config_validate(config);
  if (err != ESP_OK) {
    return err;
  }

  err = codepulse_device_config_init();
  if (err != ESP_OK) {
    return err;
  }

  nvs_handle_t handle = 0;
  err = nvs_open(DEVICE_CONFIG_NAMESPACE, NVS_READWRITE, &handle);
  if (err != ESP_OK) {
    return err;
  }

  err = nvs_set_u8(handle, DEVICE_CONFIG_KEY_VERSION, DEVICE_CONFIG_VERSION);
  if (err == ESP_OK) {
    err = nvs_set_str(handle, DEVICE_CONFIG_KEY_WIFI_SSID, config->wifi_ssid);
  }
  if (err == ESP_OK) {
    err = nvs_set_str(handle, DEVICE_CONFIG_KEY_WIFI_PASSWORD,
                      config->wifi_password);
  }
  if (err == ESP_OK) {
    err = nvs_set_str(handle, DEVICE_CONFIG_KEY_SERVER_ID, config->server_id);
  }
  if (err == ESP_OK) {
    err =
        nvs_set_str(handle, DEVICE_CONFIG_KEY_SERVER_HOST, config->server_host);
  }
  if (err == ESP_OK) {
    err =
        nvs_set_u16(handle, DEVICE_CONFIG_KEY_SERVER_PORT, config->server_port);
  }
  if (err == ESP_OK) {
    err = nvs_set_str(handle, DEVICE_CONFIG_KEY_DEVICE_TOKEN,
                      config->device_token);
  }
  if (err == ESP_OK) {
    err = nvs_commit(handle);
  }
  nvs_close(handle);
  return err;
}
