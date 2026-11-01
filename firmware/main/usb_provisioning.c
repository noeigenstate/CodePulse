#include "usb_provisioning.h"

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "device_config.h"
#include "device_identity.h"
#include "driver/usb_serial_jtag.h"
#include "esp_log.h"

#define USB_PROVISIONING_LINE_MAX_BYTES 1024
#define USB_PROVISIONING_REQUEST_ID_MAX_BYTES 64
#define USB_PROVISIONING_TASK_STACK_BYTES 6144
#define USB_PROVISIONING_TASK_PRIORITY 5

static const char *TAG = "codepulse_usb";
static TaskHandle_t s_notification_task;
static uint32_t s_notification_bit;
static bool s_started;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static codepulse_usb_runtime_state_t s_runtime_state =
    CODEPULSE_USB_RUNTIME_UNPROVISIONED;
static uint32_t s_configuration_generation;

static void secure_zero(void *memory, size_t length) {
  volatile unsigned char *cursor = (volatile unsigned char *)memory;
  while (length-- > 0) {
    *cursor++ = 0;
  }
}

static bool valid_request_id(const cJSON *id) {
  if (!cJSON_IsString(id) || id->valuestring == NULL) {
    return false;
  }
  const size_t length = strlen(id->valuestring);
  if (length == 0 || length > USB_PROVISIONING_REQUEST_ID_MAX_BYTES) {
    return false;
  }
  for (size_t index = 0; index < length; ++index) {
    const unsigned char character = (unsigned char)id->valuestring[index];
    if (character <= 0x20 || character >= 0x7f) {
      return false;
    }
  }
  return true;
}

static void add_response_id(cJSON *response, const char *id) {
  if (id == NULL) {
    cJSON_AddNullToObject(response, "id");
  } else {
    cJSON_AddStringToObject(response, "id", id);
  }
}

static void send_frame(cJSON *frame) {
  if (frame == NULL) {
    return;
  }
  char *json = cJSON_PrintUnformatted(frame);
  if (json != NULL) {
    flockfile(stdout);
    fputs(CODEPULSE_USB_FRAME_PREFIX, stdout);
    fputs(json, stdout);
    fputc('\n', stdout);
    funlockfile(stdout);
    cJSON_free(json);
  }
  cJSON_Delete(frame);
}

static void send_error(const char *id, const char *code, const char *message) {
  cJSON *response = cJSON_CreateObject();
  cJSON *error = cJSON_CreateObject();
  if (response == NULL || error == NULL) {
    cJSON_Delete(response);
    cJSON_Delete(error);
    return;
  }
  add_response_id(response, id);
  cJSON_AddBoolToObject(response, "ok", false);
  cJSON_AddStringToObject(error, "code", code);
  cJSON_AddStringToObject(error, "message", message);
  cJSON_AddItemToObject(response, "error", error);
  send_frame(response);
}

static void send_success(const char *id, cJSON *result) {
  cJSON *response = cJSON_CreateObject();
  if (response == NULL || result == NULL) {
    cJSON_Delete(response);
    cJSON_Delete(result);
    return;
  }
  add_response_id(response, id);
  cJSON_AddBoolToObject(response, "ok", true);
  cJSON_AddItemToObject(response, "result", result);
  send_frame(response);
}

static void add_capabilities(cJSON *result) {
  cJSON *capabilities = cJSON_AddArrayToObject(result, "capabilities");
  if (capabilities == NULL) {
    return;
  }
  cJSON_AddItemToArray(capabilities, cJSON_CreateString("usb-provisioning-v1"));
  cJSON_AddItemToArray(capabilities, cJSON_CreateString("mdns-codepulse-v1"));
  cJSON_AddItemToArray(capabilities, cJSON_CreateString("mdns-display-v1"));
}

static const char *runtime_state_name(codepulse_usb_runtime_state_t state) {
  switch (state) {
  case CODEPULSE_USB_RUNTIME_APPLYING:
    return "applying";
  case CODEPULSE_USB_RUNTIME_WIFI_ERROR:
    return "wifi_error";
  case CODEPULSE_USB_RUNTIME_DESKTOP_UNREACHABLE:
    return "desktop_unreachable";
  case CODEPULSE_USB_RUNTIME_READY:
    return "ready";
  case CODEPULSE_USB_RUNTIME_UNPROVISIONED:
  default:
    return "unprovisioned";
  }
}

static void read_runtime_status(codepulse_usb_runtime_state_t *state,
                                uint32_t *generation) {
  portENTER_CRITICAL(&s_state_lock);
  *state = s_runtime_state;
  *generation = s_configuration_generation;
  portEXIT_CRITICAL(&s_state_lock);
}

static void send_status_result(const char *id) {
  codepulse_device_identity_t identity;
  if (codepulse_device_identity_read(&identity) != ESP_OK) {
    send_error(id, "identity_error", "Device identity is unavailable");
    return;
  }

  codepulse_usb_runtime_state_t state;
  uint32_t generation = 0;
  read_runtime_status(&state, &generation);
  const bool wifi_connected =
      state == CODEPULSE_USB_RUNTIME_DESKTOP_UNREACHABLE ||
      state == CODEPULSE_USB_RUNTIME_READY;
  const bool desktop_reachable = state == CODEPULSE_USB_RUNTIME_READY;
  const bool provisioned = state != CODEPULSE_USB_RUNTIME_UNPROVISIONED;

  cJSON *result = cJSON_CreateObject();
  if (result == NULL) {
    send_error(id, "internal_error", "The response could not be allocated");
    return;
  }
  cJSON_AddNumberToObject(result, "protocolVersion",
                          CODEPULSE_USB_PROVISIONING_PROTOCOL_VERSION);
  cJSON_AddStringToObject(result, "deviceId", identity.device_id);
  cJSON_AddBoolToObject(result, "provisioned", provisioned);
  cJSON_AddStringToObject(result, "state", runtime_state_name(state));
  cJSON_AddBoolToObject(result, "wifiConnected", wifi_connected);
  cJSON_AddBoolToObject(result, "desktopReachable", desktop_reachable);
  cJSON_AddNumberToObject(result, "configurationGeneration", generation);
  send_success(id, result);
}

static void send_device_result(const char *id, bool include_config) {
  codepulse_device_identity_t identity;
  const esp_err_t identity_err = codepulse_device_identity_read(&identity);
  if (identity_err != ESP_OK) {
    send_error(id, "identity_error", "Device identity is unavailable");
    return;
  }

  codepulse_device_config_t config;
  const esp_err_t config_err = codepulse_device_config_load(&config);
  const bool provisioned = config_err == ESP_OK;

  cJSON *result = cJSON_CreateObject();
  if (result == NULL) {
    secure_zero(&config, sizeof(config));
    send_error(id, "internal_error", "The response could not be allocated");
    return;
  }
  cJSON_AddNumberToObject(result, "protocolVersion",
                          CODEPULSE_USB_PROVISIONING_PROTOCOL_VERSION);
  cJSON_AddStringToObject(result, "deviceId", identity.device_id);
  cJSON_AddStringToObject(result, "firmwareVersion", identity.firmware_version);
  cJSON_AddNumberToObject(result, "hardwareRevision",
                          identity.hardware_revision);
  cJSON_AddBoolToObject(result, "provisioned", provisioned);
  add_capabilities(result);

  if (include_config && provisioned) {
    cJSON_AddStringToObject(result, "wifiSsid", config.wifi_ssid);
    cJSON_AddStringToObject(result, "serverId", config.server_id);
    cJSON_AddStringToObject(result, "fallbackHost", config.server_host);
    cJSON_AddNumberToObject(result, "fallbackPort", config.server_port);
  }

  secure_zero(&config, sizeof(config));
  send_success(id, result);
}

static bool copy_required_string(const cJSON *object, const char *key,
                                 char *destination, size_t capacity) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!cJSON_IsString(value) || value->valuestring == NULL) {
    return false;
  }
  const size_t length = strlen(value->valuestring);
  if (length >= capacity) {
    return false;
  }
  memcpy(destination, value->valuestring, length + 1);
  return true;
}

static bool copy_optional_string(const cJSON *object, const char *key,
                                 char *destination, size_t capacity) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (value == NULL || cJSON_IsNull(value)) {
    destination[0] = '\0';
    return true;
  }
  return copy_required_string(object, key, destination, capacity);
}

static bool read_optional_port(const cJSON *object, uint16_t *port) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, "fallbackPort");
  if (value == NULL || cJSON_IsNull(value)) {
    *port = CODEPULSE_DEFAULT_DEVICE_API_PORT;
    return true;
  }
  if (!cJSON_IsNumber(value) || value->valuedouble < 1.0 ||
      value->valuedouble > 65535.0 ||
      value->valuedouble != (double)value->valueint) {
    return false;
  }
  *port = (uint16_t)value->valueint;
  return true;
}

static void wipe_json_string(cJSON *object, const char *key) {
  cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (cJSON_IsString(value) && value->valuestring != NULL) {
    secure_zero(value->valuestring, strlen(value->valuestring));
  }
}

static void handle_provision(const char *id, cJSON *params) {
  if (!cJSON_IsObject(params)) {
    send_error(id, "invalid_params", "Provisioning parameters are required");
    return;
  }

  codepulse_device_config_t config = {
      .server_port = CODEPULSE_DEFAULT_DEVICE_API_PORT,
  };
  const bool fields_valid =
      copy_required_string(params, "wifiSsid", config.wifi_ssid,
                           sizeof(config.wifi_ssid)) &&
      copy_required_string(params, "wifiPassword", config.wifi_password,
                           sizeof(config.wifi_password)) &&
      copy_required_string(params, "serverId", config.server_id,
                           sizeof(config.server_id)) &&
      copy_required_string(params, "deviceToken", config.device_token,
                           sizeof(config.device_token)) &&
      copy_optional_string(params, "fallbackHost", config.server_host,
                           sizeof(config.server_host)) &&
      read_optional_port(params, &config.server_port) &&
      config.server_id[0] != '\0';

  esp_err_t err = ESP_ERR_INVALID_ARG;
  if (fields_valid) {
    err = codepulse_device_config_save(&config);
  }

  wipe_json_string(params, "wifiPassword");
  wipe_json_string(params, "deviceToken");
  secure_zero(&config, sizeof(config));

  if (err != ESP_OK) {
    const char *code = fields_valid ? "storage_error" : "invalid_params";
    const char *message = fields_valid
                              ? "The configuration could not be saved"
                              : "One or more provisioning fields are invalid";
    send_error(id, code, message);
    return;
  }

  portENTER_CRITICAL(&s_state_lock);
  ++s_configuration_generation;
  s_runtime_state = CODEPULSE_USB_RUNTIME_APPLYING;
  portEXIT_CRITICAL(&s_state_lock);

  cJSON *result = cJSON_CreateObject();
  if (result == NULL) {
    send_error(id, "internal_error", "The response could not be allocated");
  } else {
    cJSON_AddBoolToObject(result, "saved", true);
    cJSON_AddBoolToObject(result, "applyQueued", true);
    send_success(id, result);
  }
  xTaskNotify(s_notification_task, s_notification_bit, eSetBits);
  ESP_LOGI(TAG, "validated configuration committed; runtime apply queued");
}

static cJSON *parse_complete_json(const char *json, size_t length) {
  const char *parse_end = NULL;
  cJSON *root = cJSON_ParseWithLengthOpts(json, length, &parse_end, false);
  const char *const json_end = json + length;
  while (parse_end != NULL && parse_end < json_end &&
         isspace((unsigned char)*parse_end)) {
    ++parse_end;
  }
  if (!cJSON_IsObject(root) || parse_end != json_end) {
    cJSON_Delete(root);
    return NULL;
  }
  return root;
}

static void handle_line(char *line, size_t length) {
  const size_t prefix_length = strlen(CODEPULSE_USB_FRAME_PREFIX);
  if (length <= prefix_length ||
      memcmp(line, CODEPULSE_USB_FRAME_PREFIX, prefix_length) != 0) {
    return;
  }

  cJSON *request =
      parse_complete_json(line + prefix_length, length - prefix_length);
  if (request == NULL) {
    send_error(NULL, "invalid_json", "The request is not valid JSON");
    return;
  }

  const cJSON *id_value = cJSON_GetObjectItemCaseSensitive(request, "id");
  const char *id = valid_request_id(id_value) ? id_value->valuestring : NULL;
  if (id == NULL) {
    send_error(NULL, "invalid_request", "A printable request id is required");
    cJSON_Delete(request);
    return;
  }

  const cJSON *version =
      cJSON_GetObjectItemCaseSensitive(request, "protocolVersion");
  if (!cJSON_IsNumber(version) ||
      version->valuedouble !=
          (double)CODEPULSE_USB_PROVISIONING_PROTOCOL_VERSION) {
    send_error(id, "unsupported_protocol",
               "Only USB protocol version 1 is supported");
    cJSON_Delete(request);
    return;
  }

  const cJSON *operation =
      cJSON_GetObjectItemCaseSensitive(request, "operation");
  if (!cJSON_IsString(operation) || operation->valuestring == NULL) {
    send_error(id, "invalid_request", "A provisioning operation is required");
    cJSON_Delete(request);
    return;
  }

  if (strcmp(operation->valuestring, "hello") == 0) {
    send_device_result(id, false);
  } else if (strcmp(operation->valuestring, "getConfig") == 0) {
    send_device_result(id, true);
  } else if (strcmp(operation->valuestring, "getStatus") == 0) {
    send_status_result(id);
  } else if (strcmp(operation->valuestring, "provision") == 0) {
    cJSON *params = cJSON_GetObjectItemCaseSensitive(request, "params");
    handle_provision(id, params);
  } else {
    send_error(id, "unknown_operation", "The operation is not supported");
  }

  cJSON_Delete(request);
}

static void usb_provisioning_task(void *argument) {
  (void)argument;
  char line[USB_PROVISIONING_LINE_MAX_BYTES + 1];
  size_t line_length = 0;
  bool overflow = false;

  for (;;) {
    uint8_t incoming[128];
    const int received = usb_serial_jtag_read_bytes(incoming, sizeof(incoming),
                                                    pdMS_TO_TICKS(250));
    for (int index = 0; index < received; ++index) {
      const char character = (char)incoming[index];
      if (character == '\r') {
        continue;
      }
      if (character == '\n') {
        if (overflow) {
          send_error(NULL, "line_too_long",
                     "The USB request exceeds 1024 bytes");
        } else if (line_length > 0) {
          line[line_length] = '\0';
          handle_line(line, line_length);
        }
        secure_zero(line, sizeof(line));
        line_length = 0;
        overflow = false;
        continue;
      }
      if (overflow) {
        continue;
      }
      if (line_length >= USB_PROVISIONING_LINE_MAX_BYTES) {
        overflow = true;
        secure_zero(line, sizeof(line));
        line_length = 0;
        continue;
      }
      line[line_length++] = character;
    }
    secure_zero(incoming, sizeof(incoming));
  }
}

esp_err_t codepulse_usb_provisioning_start(TaskHandle_t notification_task,
                                           uint32_t notification_bit) {
  if (notification_task == NULL || notification_bit == 0) {
    return ESP_ERR_INVALID_ARG;
  }
  if (s_started) {
    return ESP_ERR_INVALID_STATE;
  }
  s_notification_task = notification_task;
  s_notification_bit = notification_bit;

  if (xTaskCreate(usb_provisioning_task, "usb_provision",
                  USB_PROVISIONING_TASK_STACK_BYTES, NULL,
                  USB_PROVISIONING_TASK_PRIORITY, NULL) != pdPASS) {
    s_notification_task = NULL;
    s_notification_bit = 0;
    return ESP_ERR_NO_MEM;
  }
  s_started = true;
  ESP_LOGI(TAG, "USB provisioning protocol v1 ready");
  return ESP_OK;
}

void codepulse_usb_provisioning_set_runtime_state(
    codepulse_usb_runtime_state_t state) {
  portENTER_CRITICAL(&s_state_lock);
  s_runtime_state = state;
  portEXIT_CRITICAL(&s_state_lock);
}

uint32_t codepulse_usb_provisioning_configuration_generation(void) {
  uint32_t generation = 0;
  portENTER_CRITICAL(&s_state_lock);
  generation = s_configuration_generation;
  portEXIT_CRITICAL(&s_state_lock);
  return generation;
}
