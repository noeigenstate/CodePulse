#include "wifi_manager.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAILED_BIT BIT1
#define WIFI_MAXIMUM_RETRIES 5

static const char *TAG = "codepulse_wifi";
static EventGroupHandle_t s_events;
static bool s_initialized;
static bool s_started;
static bool s_connected;
static bool s_stop_requested;
static unsigned int s_retry_count;

static void wifi_event_handler(void *argument, esp_event_base_t event_base,
                               int32_t event_id, void *event_data) {
  (void)argument;

  if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
    if (!s_stop_requested) {
      esp_wifi_connect();
    }
    return;
  }

  if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
    s_connected = false;
    xEventGroupClearBits(s_events, WIFI_CONNECTED_BIT);
    if (s_stop_requested) {
      return;
    }

    if (s_retry_count < WIFI_MAXIMUM_RETRIES) {
      ++s_retry_count;
      ESP_LOGW(TAG, "Wi-Fi disconnected; retry %u/%u", s_retry_count,
               WIFI_MAXIMUM_RETRIES);
      esp_wifi_connect();
    } else {
      xEventGroupSetBits(s_events, WIFI_FAILED_BIT);
    }
    return;
  }

  if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
    const ip_event_got_ip_t *event = (const ip_event_got_ip_t *)event_data;
    s_retry_count = 0;
    s_connected = true;
    xEventGroupClearBits(s_events, WIFI_FAILED_BIT);
    xEventGroupSetBits(s_events, WIFI_CONNECTED_BIT);
    ESP_LOGI(TAG, "connected; address=" IPSTR, IP2STR(&event->ip_info.ip));
  }
}

static esp_err_t wifi_manager_init(void) {
  if (s_initialized) {
    return ESP_OK;
  }

  s_events = xEventGroupCreate();
  if (s_events == NULL) {
    return ESP_ERR_NO_MEM;
  }

  esp_err_t err = esp_netif_init();
  if (err != ESP_OK) {
    return err;
  }
  err = esp_event_loop_create_default();
  if (err != ESP_OK) {
    return err;
  }
  if (esp_netif_create_default_wifi_sta() == NULL) {
    return ESP_ERR_NO_MEM;
  }

  const wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT();
  err = esp_wifi_init(&wifi_init);
  if (err != ESP_OK) {
    return err;
  }
  err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
  if (err != ESP_OK) {
    return err;
  }
  err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                   wifi_event_handler, NULL);
  if (err != ESP_OK) {
    return err;
  }
  err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                   wifi_event_handler, NULL);
  if (err != ESP_OK) {
    return err;
  }

  s_initialized = true;
  return ESP_OK;
}

esp_err_t wifi_manager_connect(const codepulse_device_config_t *config,
                               uint32_t timeout_ms) {
  if (config == NULL || timeout_ms == 0) {
    return ESP_ERR_INVALID_ARG;
  }
  if (s_connected) {
    return ESP_OK;
  }

  esp_err_t err = wifi_manager_init();
  if (err != ESP_OK) {
    return err;
  }

  wifi_config_t wifi_config = {0};
  const size_t ssid_length = strlen(config->wifi_ssid);
  const size_t password_length = strlen(config->wifi_password);
  memcpy(wifi_config.sta.ssid, config->wifi_ssid, ssid_length);
  memcpy(wifi_config.sta.password, config->wifi_password, password_length);
  wifi_config.sta.threshold.authmode =
      password_length == 0 ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;

  s_stop_requested = false;
  s_retry_count = 0;
  xEventGroupClearBits(s_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT);

  err = esp_wifi_set_mode(WIFI_MODE_STA);
  if (err != ESP_OK) {
    return err;
  }
  err = esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
  if (err != ESP_OK) {
    return err;
  }

  if (!s_started) {
    err = esp_wifi_start();
    if (err != ESP_OK) {
      return err;
    }
    s_started = true;
    const esp_err_t power_save_err = esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    if (power_save_err != ESP_OK) {
      ESP_LOGW(TAG, "failed to enable modem power save: %s",
               esp_err_to_name(power_save_err));
    }
  } else {
    err = esp_wifi_connect();
    if (err != ESP_OK) {
      return err;
    }
  }

  const EventBits_t result =
      xEventGroupWaitBits(s_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT,
                          pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
  if ((result & WIFI_CONNECTED_BIT) != 0) {
    return ESP_OK;
  }
  if ((result & WIFI_FAILED_BIT) != 0) {
    return ESP_FAIL;
  }
  return ESP_ERR_TIMEOUT;
}

bool wifi_manager_is_connected(void) { return s_connected; }

esp_err_t wifi_manager_stop(void) {
  if (!s_initialized || !s_started) {
    return ESP_OK;
  }

  s_stop_requested = true;
  s_connected = false;
  xEventGroupClearBits(s_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT);
  const esp_err_t err = esp_wifi_stop();
  if (err == ESP_OK) {
    s_started = false;
  }
  return err;
}
