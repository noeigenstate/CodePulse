#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "aht20.h"
#include "battery_adc.h"
#include "board_pins.h"
#include "board_safety.h"
#include "buzzer.h"
#include "codepulse_client.h"
#include "codepulse_audio.h"
#include "codepulse_discovery.h"
#include "codepulse_protocol.h"
#include "codepulse_ui.h"
#include "device_config.h"
#include "display_sync_policy.h"
#include "quiet_dashboard.h"
#include "quiet_profile.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "epd_canvas.h"
#include "epd_ssd1683.h"
#ifdef CODEPULSE_EPD_RED_MASK_PROBE
#include "red_mask_probe.h"
#endif
#ifdef CODEPULSE_EPD_RED_BADGE_PROBE
#include "red_badge_probe.h"
#endif
#ifdef CODEPULSE_EPD_RED_LUT5_PROBE
#include "red_lut5_probe.h"
#endif
#ifdef CODEPULSE_EPD_PANEL_READBACK
#include "panel_readback.h"
#endif
#ifdef CODEPULSE_EPD_RED_LUT_PROBE
#include "red_lut_probe.h"
#endif
#ifdef CODEPULSE_EPD_RED_REGION_PROBE
#include "red_probe.h"
#endif
#ifdef CODEPULSE_EPD_RESOLUTION_PROBE
#include "resolution_probe.h"
#endif
#ifdef CODEPULSE_EPD_TEXT_TIMING_PROBE
#include "timing_probe.h"
#endif
#ifdef CODEPULSE_EPD_TEXT_PROBE
#include "text_probe.h"
#endif
#ifdef CODEPULSE_EPD_QUIET_PROBE
#include "quiet_probe.h"
#endif
#ifdef CODEPULSE_EPD_WAVEFORM_PROBE
#include "waveform_probe.h"
#endif
#ifdef CODEPULSE_EPD_WINDOW_PROBE
#include "window_probe.h"
#endif
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_chip_info.h"
#include "esp_err.h"
#include "esp_flash.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "usb_provisioning.h"
#include "wifi_manager.h"

#if BOARD_EPD_PHYSICAL_REFRESH_ENABLED != 1
#error "This image requires the confirmed WFT0420CZ15 physical panel"
#endif

#if BOARD_HAS_VALID_BAT_ADC != 1
#error "This image requires the documented GPIO42-to-GPIO8 battery ADC flywire"
#endif

static const char *TAG = "codepulse_bringup";
static uint8_t s_black_plane[EPD_CANVAS_BUFFER_SIZE];
static uint8_t s_red_plane[EPD_CANVAS_BUFFER_SIZE];
static quiet_dashboard_t s_quiet_display;
static bool s_manual_sync_pending;
static void shutdown_safely(void);

static void refresh_dashboard(
    epd_canvas_t *canvas, const codepulse_ui_model_t *model,
    bool *display_ready, display_sync_policy_t *policy, bool manual) {
  if (manual) s_manual_sync_pending = true;
  const int64_t now = esp_timer_get_time() / 1000;
  (void)display_sync_evaluate(policy, now, model);
  codepulse_ui_model_t target;
  display_sync_project(policy, now, model, s_manual_sync_pending, &target);
  esp_err_t err = ESP_OK;
  if (!*display_ready) {
    err = epd_ssd1683_init();
    *display_ready = err == ESP_OK;
  }
  quiet_dashboard_result_t result = {0};
  if (err == ESP_OK) err = quiet_dashboard_update(&s_quiet_display, canvas, &target,
                                                esp_timer_get_time() / 1000, &result);
  ESP_LOGI(TAG, "dashboard mode=%s y=%u height=%u total=%" PRIu32
           " refresh=%" PRIu32 " busy=%d result=%s init=%" PRIu32
           " upload=%" PRIu32 " off=%" PRIu32 " busy_assert=%" PRIu32
           " busy_low=%" PRIu32 " x=%u width=%u",
           result.red_full ? "red_full" : result.full ? "clean_baseline" : result.changed ? EPD_QUIET_LOG_MODE : "unchanged",
           result.y, result.height, result.timing.total_ms, result.timing.refresh_ms,
           result.timing.busy_seen, esp_err_to_name(err), result.timing.init_ms,
           result.timing.upload_ms, result.timing.off_ms,
           result.timing.busy_assert_ms, result.timing.busy_low_ms,
           result.timing.x, result.full ? BOARD_EPD_WIDTH : result.timing.width);
  display_sync_record_attempt(policy, esp_timer_get_time() / 1000, &target, err == ESP_OK);
  if (err != ESP_OK) {
    /* Optical OLD may be wrong, and HV shutdown may have failed. Stop instead
     * of retrying/full flashing; release board supply through the safe path. */
    ESP_LOGE(TAG, "display fault; stopping without automatic retry or full refresh");
    shutdown_safely();
  }
  s_manual_sync_pending = false;
}

#define POWER_ON_HOLD_MS 3000
#define BUTTON_DEBOUNCE_MS 30
#define SHORT_PRESS_MIN_MS 50
#define SHORT_PRESS_MAX_MS 1000
#define LONG_PRESS_MS 3000
#define BUTTON_POLL_MS 10
#define APP_NOTIFY_BUTTON_SHORT (UINT32_C(1) << 0)
#define APP_NOTIFY_BUTTON_LONG (UINT32_C(1) << 1)
#define APP_NOTIFY_CONFIG_UPDATED (UINT32_C(1) << 2)
#define POWER_SESSION_MAGIC UINT32_C(0x43505057)

RTC_NOINIT_ATTR static uint32_t s_power_session_magic;
RTC_NOINIT_ATTR static uint32_t s_power_session_magic_inverse;

typedef enum {
  BUTTON_EVENT_NONE,
  BUTTON_EVENT_SHORT_PRESS,
  BUTTON_EVENT_LONG_PRESS,
} button_event_t;

typedef struct {
  bool raw_pressed;
  bool stable_pressed;
  bool long_press_reported;
  TickType_t raw_changed_at;
  TickType_t press_started_at;
} button_tracker_t;

static esp_err_t diagnostic_console_init(void) {
  usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_CRLF);

  if (!usb_serial_jtag_is_driver_installed()) {
    usb_serial_jtag_driver_config_t config = {
        .tx_buffer_size = 2048,
        .rx_buffer_size = 2048,
    };

    const esp_err_t err = usb_serial_jtag_driver_install(&config);
    if (err != ESP_OK) {
      return err;
    }
  }

  usb_serial_jtag_vfs_use_driver();
  setvbuf(stdout, NULL, _IONBF, 0);
  return ESP_OK;
}

static void idle_safely_forever(void) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

static bool button_is_pressed(void) { return gpio_get_level(PIN_BUTTON) == 0; }

static bool power_session_is_active(void) {
  return s_power_session_magic == POWER_SESSION_MAGIC &&
         s_power_session_magic_inverse == ~POWER_SESSION_MAGIC;
}

static void power_session_mark_active(void) {
  s_power_session_magic = POWER_SESSION_MAGIC;
  s_power_session_magic_inverse = ~POWER_SESSION_MAGIC;
}

static void power_session_clear(void) {
  s_power_session_magic = 0;
  s_power_session_magic_inverse = 0;
}

static bool wait_for_power_on_hold(void) {
  const int64_t hold_deadline_us = (int64_t)POWER_ON_HOLD_MS * 1000;
  int64_t released_since_us = -1;

  for (;;) {
    const int64_t now_us = esp_timer_get_time();
    if (button_is_pressed()) {
      released_since_us = -1;
    } else if (released_since_us < 0) {
      released_since_us = now_us;
    } else if (now_us - released_since_us >=
               (int64_t)BUTTON_DEBOUNCE_MS * 1000) {
      return false;
    }

    if (now_us >= hold_deadline_us && button_is_pressed()) {
      return true;
    }
    vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
  }
}

static void wait_for_button_release(void) {
  int64_t released_since_us = -1;

  for (;;) {
    const int64_t now_us = esp_timer_get_time();
    if (button_is_pressed()) {
      released_since_us = -1;
    } else if (released_since_us < 0) {
      released_since_us = now_us;
    } else if (now_us - released_since_us >=
               (int64_t)BUTTON_DEBOUNCE_MS * 1000) {
      return;
    }
    vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
  }
}

static void button_tracker_init(button_tracker_t *tracker) {
  const bool pressed = button_is_pressed();
  const TickType_t now = xTaskGetTickCount();
  *tracker = (button_tracker_t){
      .raw_pressed = pressed,
      .stable_pressed = pressed,
      .long_press_reported = false,
      .raw_changed_at = now,
      .press_started_at = now,
  };
}

static button_event_t button_tracker_poll(button_tracker_t *tracker) {
  const TickType_t now = xTaskGetTickCount();
  const bool pressed = button_is_pressed();

  if (pressed != tracker->raw_pressed) {
    tracker->raw_pressed = pressed;
    tracker->raw_changed_at = now;
  }

  if (pressed != tracker->stable_pressed &&
      now - tracker->raw_changed_at >= pdMS_TO_TICKS(BUTTON_DEBOUNCE_MS)) {
    tracker->stable_pressed = pressed;
    if (pressed) {
      tracker->press_started_at = now;
      tracker->long_press_reported = false;
    } else if (!tracker->long_press_reported) {
      const TickType_t press_duration = now - tracker->press_started_at;
      if (press_duration >= pdMS_TO_TICKS(SHORT_PRESS_MIN_MS) &&
          press_duration <= pdMS_TO_TICKS(SHORT_PRESS_MAX_MS)) {
        return BUTTON_EVENT_SHORT_PRESS;
      }

      ESP_LOGW(TAG, "ignored button press lasting %" PRIu32 " ms",
               (uint32_t)(press_duration * portTICK_PERIOD_MS));
    }
  }

  if (tracker->stable_pressed && tracker->raw_pressed &&
      !tracker->long_press_reported &&
      now - tracker->press_started_at >= pdMS_TO_TICKS(LONG_PRESS_MS)) {
    tracker->long_press_reported = true;
    return BUTTON_EVENT_LONG_PRESS;
  }

  return BUTTON_EVENT_NONE;
}

static void button_monitor_task(void *argument) {
  TaskHandle_t application_task = (TaskHandle_t)argument;
  button_tracker_t tracker;
  button_tracker_init(&tracker);

  for (;;) {
    const button_event_t event = button_tracker_poll(&tracker);
    if (event == BUTTON_EVENT_SHORT_PRESS) {
      xTaskNotify(application_task, APP_NOTIFY_BUTTON_SHORT, eSetBits);
    } else if (event == BUTTON_EVENT_LONG_PRESS) {
      xTaskNotify(application_task, APP_NOTIFY_BUTTON_LONG, eSetBits);
    }
    vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
  }
}

static void shutdown_safely(void) {
  codepulse_audio_stop();
  ESP_LOGI(TAG, "3-second shutdown hold accepted; status LED is off");
  power_session_clear();
  board_status_led_set(false);

  const esp_err_t buzzer_err = buzzer_stop();
  if (buzzer_err != ESP_OK) {
    ESP_LOGE(TAG, "failed to stop buzzer: %s", esp_err_to_name(buzzer_err));
  }

  codepulse_discovery_stop();
  const esp_err_t wifi_err = wifi_manager_stop();
  if (wifi_err != ESP_OK) {
    ESP_LOGE(TAG, "failed to stop Wi-Fi: %s", esp_err_to_name(wifi_err));
  }

  const esp_err_t sleep_err = epd_ssd1683_deep_sleep();
  if (sleep_err != ESP_OK) {
    ESP_LOGE(TAG, "panel shutdown preparation failed: %s",
             esp_err_to_name(sleep_err));
  }
  vTaskDelay(pdMS_TO_TICKS(20));

  const esp_err_t release_err = board_power_release();
  if (release_err != ESP_OK) {
    ESP_LOGE(TAG, "failed to release power latch: %s",
             esp_err_to_name(release_err));
  }

  /* The physical button still supplies LDO_CE until the user releases it. */
  idle_safely_forever();
}

static bool read_environment_sample(bool *sensor_ready,
                                    aht20_sample_t *sample) {
  if (!*sensor_ready) {
    const esp_err_t init_err = aht20_init();
    if (init_err != ESP_OK) {
      ESP_LOGE(TAG, "AHT20 initialization failed: %s",
               esp_err_to_name(init_err));
      return false;
    }
    *sensor_ready = true;
  }

  const esp_err_t read_err = aht20_read(sample);
  if (read_err != ESP_OK) {
    ESP_LOGE(TAG, "AHT20 measurement failed: %s", esp_err_to_name(read_err));
    return false;
  }

  ESP_LOGI(TAG, "temperature=%.2f C humidity=%.2f %%RH",
           (double)sample->temperature_c, (double)sample->humidity_rh);
  return true;
}

static bool read_battery_sample(bool *battery_ready, battery_sample_t *sample) {
  if (!*battery_ready) {
    const esp_err_t init_err = battery_adc_init();
    if (init_err != ESP_OK) {
      ESP_LOGE(TAG, "battery ADC initialization failed: %s",
               esp_err_to_name(init_err));
      return false;
    }
    *battery_ready = true;
  }

  const esp_err_t read_err = battery_adc_read(sample);
  if (read_err != ESP_OK) {
    ESP_LOGE(TAG,
             "battery measurement failed: %s raw=%d calculated_mv=%" PRIu32,
             esp_err_to_name(read_err), sample->raw, sample->voltage_mv);
    return false;
  }

  ESP_LOGI(TAG,
           "battery=%" PRIu32 " mV estimated_charge=%u %% raw=%d calibrated=%s",
           sample->voltage_mv, sample->percent, sample->raw,
           sample->calibrated ? "true" : "false");
  return true;
}

static void log_hardware_report(void) {
  const esp_app_desc_t *app = esp_app_get_description();
  esp_chip_info_t chip = {0};
  uint32_t flash_size = 0;

  esp_chip_info(&chip);

  ESP_LOGI(TAG, "firmware=%s idf=%s hw_rev=%d reset_reason=%d", app->version,
           esp_get_idf_version(), BOARD_HW_REV, (int)esp_reset_reason());
  ESP_LOGI(TAG, "chip=esp32s3 cores=%u silicon_revision=%u.%u", chip.cores,
           chip.revision / 100, chip.revision % 100);

  const esp_err_t flash_err = esp_flash_get_size(NULL, &flash_size);
  if (flash_err == ESP_OK) {
    ESP_LOGI(TAG, "flash_bytes=%" PRIu32 " expected_bytes=%u", flash_size,
             16U * 1024U * 1024U);
    if (flash_size != 16U * 1024U * 1024U) {
      ESP_LOGW(TAG, "unexpected flash size for ESP32-S3-WROOM-1-N16R8");
    }
  } else {
    ESP_LOGE(TAG, "flash size read failed: %s", esp_err_to_name(flash_err));
  }

  const bool psram_ready = esp_psram_is_initialized();
  const size_t psram_size = esp_psram_get_size();
  ESP_LOGI(TAG, "psram_ready=%s psram_bytes=%zu expected_bytes=%u",
           psram_ready ? "true" : "false", psram_size, 8U * 1024U * 1024U);
  if (!psram_ready || psram_size != 8U * 1024U * 1024U) {
    ESP_LOGW(TAG, "unexpected PSRAM result for N16R8 module");
  }

  ESP_LOGI(TAG, "free_heap_bytes=%" PRIu32, esp_get_free_heap_size());
}

static codepulse_ui_model_t make_dashboard_model(
    const aht20_sample_t *sample, bool sample_valid,
    const battery_sample_t *battery, bool battery_valid,
    const codepulse_remote_status_t *remote, bool server_reachable) {
  codepulse_ui_model_t model = {
      .environment_valid = sample_valid,
      .temperature_c = sample->temperature_c,
      .humidity_rh = sample->humidity_rh,
      .battery_valid = battery_valid,
      .battery_percent = battery->percent,
      .wifi_connected = server_reachable,
      .work_status_stale = !server_reachable,
      .agents =
          {
              {
                  .type = CODEPULSE_UI_AGENT_CLAUDE,
                  .state = CODEPULSE_UI_AGENT_OFFLINE,
                  .five_hour_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
                  .weekly_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
              },
              {
                  .type = CODEPULSE_UI_AGENT_CODEX,
                  .state = CODEPULSE_UI_AGENT_OFFLINE,
                  .five_hour_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
                  .weekly_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
              },
              {
                  .type = CODEPULSE_UI_AGENT_GROK,
                  .state = CODEPULSE_UI_AGENT_OFFLINE,
                  .five_hour_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
                  .weekly_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
              },
          },
      .agent_count = CODEPULSE_UI_MAX_AGENTS,
  };

  codepulse_remote_apply(remote, &model);
  if (!server_reachable) { model.ambient = NULL; model.ambient_id[0] = 0; }
  return model;
}

static bool sync_codepulse_status(const codepulse_device_config_t *config,
                                  codepulse_client_t *client,
                                  codepulse_remote_status_t *remote, uint32_t wait_ms) {
  if (!wifi_manager_is_connected()) {
    ESP_LOGI(TAG, "connecting to provisioned Wi-Fi network");
    const esp_err_t wifi_err = wifi_manager_connect(config, 15000);
    if (wifi_err != ESP_OK) {
      ESP_LOGE(TAG, "Wi-Fi connection failed: %s", esp_err_to_name(wifi_err));
      return false;
    }
    codepulse_discovery_invalidate();
  }

  const esp_err_t discovery_err = codepulse_discovery_start();
  if (discovery_err != ESP_OK) {
    ESP_LOGW(TAG, "mDNS discovery is unavailable: %s",
             esp_err_to_name(discovery_err));
  }

  codepulse_server_endpoint_t endpoint;
  const esp_err_t endpoint_err =
      codepulse_discovery_resolve(config, 3000, &endpoint);
  if (endpoint_err != ESP_OK) {
    ESP_LOGE(TAG, "CodePulse desktop endpoint was not found: %s",
             esp_err_to_name(endpoint_err));
    return false;
  }

  codepulse_device_config_t request_config = *config;
  memcpy(request_config.server_host, endpoint.host, strlen(endpoint.host) + 1);
  request_config.server_port = endpoint.port;

  codepulse_fetch_result_t fetch_result = CODEPULSE_FETCH_UNCHANGED;
  const esp_err_t fetch_err =
      codepulse_client_watch(&request_config, client, remote, &fetch_result, wait_ms);
  if (fetch_err != ESP_OK) {
    codepulse_discovery_invalidate();
    ESP_LOGE(TAG, "CodePulse device API request failed: %s",
             esp_err_to_name(fetch_err));
    return false;
  }

  codepulse_discovery_remember(config, &endpoint);
  if (!wait_ms) ESP_LOGI(TAG, "CodePulse status ready revision=%s", remote->revision);
  /* Full token/activity payloads can change rapidly without changing pixels.
   * Log actual display requests below; keep transport chatter at debug level. */
  ESP_LOGD(TAG, "CodePulse status %s revision=%s",
           fetch_result == CODEPULSE_FETCH_UPDATED ? "updated" : "unchanged", remote->revision);
  return true;
}

static bool load_network_configuration(codepulse_device_config_t *config) {
  const esp_err_t err = codepulse_device_config_load(config);
  if (err == ESP_OK) {
    if (config->server_id[0] != '\0') {
      if (config->server_host[0] != '\0') {
        ESP_LOGI(TAG,
                 "network configuration loaded; server_id=%s fallback=%s:%u",
                 config->server_id, config->server_host,
                 (unsigned int)config->server_port);
      } else {
        ESP_LOGI(TAG,
                 "network configuration loaded; server_id=%s fallback=none",
                 config->server_id);
      }
    } else {
      ESP_LOGW(TAG, "legacy network configuration loaded; fallback=%s:%u",
               config->server_host, (unsigned int)config->server_port);
    }
    return true;
  }

  memset(config, 0, sizeof(*config));
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    ESP_LOGW(TAG, "network configuration is missing; connect through the "
                  "CodePulse desktop app over USB");
  } else {
    ESP_LOGE(TAG, "network configuration is invalid: %s", esp_err_to_name(err));
  }
  return false;
}

static void update_usb_runtime_state(uint32_t applied_generation,
                                     bool configuration_ready,
                                     bool server_reachable) {
  if (codepulse_usb_provisioning_configuration_generation() !=
      applied_generation) {
    codepulse_usb_provisioning_set_runtime_state(
        CODEPULSE_USB_RUNTIME_APPLYING);
    return;
  }
  codepulse_usb_runtime_state_t state = CODEPULSE_USB_RUNTIME_UNPROVISIONED;
  if (configuration_ready && server_reachable) {
    state = CODEPULSE_USB_RUNTIME_READY;
  } else if (configuration_ready && wifi_manager_is_connected()) {
    state = CODEPULSE_USB_RUNTIME_DESKTOP_UNREACHABLE;
  } else if (configuration_ready) {
    state = CODEPULSE_USB_RUNTIME_WIFI_ERROR;
  }
  codepulse_usb_provisioning_set_runtime_state(state);
}

void app_main(void) {
  /* FW-SPEC V0.9: this must be the first board-level operation. */
  const esp_err_t hold_err = board_power_hold_early();
  if (hold_err != ESP_OK) {
    /* Logging is intentionally skipped: the power latch is not reliable. */
    idle_safely_forever();
  }

  const esp_reset_reason_t reset_reason = esp_reset_reason();
  const bool resume_power_session =
      reset_reason == ESP_RST_USB && power_session_is_active();
  if (!resume_power_session) {
    power_session_clear();
  }

  const esp_err_t gpio_err = board_safe_gpio_init();
  if (gpio_err != ESP_OK) {
    ESP_LOGE(TAG, "safe GPIO initialization failed: %s",
             esp_err_to_name(gpio_err));
    idle_safely_forever();
  }

  const esp_err_t console_err = diagnostic_console_init();
  if (console_err != ESP_OK) {
    /* Power and panel safety do not depend on the diagnostic console. */
    idle_safely_forever();
  }

  if (resume_power_session) {
    ESP_LOGI(TAG, "USB reset detected in an active power session; keeping the "
                  "board on");
  } else {
    ESP_LOGI(TAG, "hold the power button for 3 seconds to start");
    if (!wait_for_power_on_hold()) {
      ESP_LOGW(TAG, "power button released before 3 seconds; shutting down");
      board_status_led_set(false);
      vTaskDelay(pdMS_TO_TICKS(20));
      board_power_release();
      idle_safely_forever();
    }
    power_session_mark_active();
  }

  const esp_err_t led_err = board_status_led_set(true);
  if (led_err != ESP_OK) {
    ESP_LOGE(TAG, "status LED initialization failed: %s",
             esp_err_to_name(led_err));
    power_session_clear();
    board_power_release();
    idle_safely_forever();
  }
  if (resume_power_session) {
    ESP_LOGI(TAG, "power session restored after USB reset; status LED is on");
  } else {
    ESP_LOGI(TAG, "3-second power-on hold accepted; status LED is on");

    /* The power-on release is consumed here and cannot become a short press. */
    wait_for_button_release();
    ESP_LOGI(TAG, "power button released; short press refresh is armed");
  }

#if defined(CODEPULSE_EPD_WINDOW_PROBE) || defined(CODEPULSE_EPD_WAVEFORM_PROBE) || defined(CODEPULSE_EPD_QUIET_PROBE) || defined(CODEPULSE_EPD_TEXT_PROBE) || defined(CODEPULSE_EPD_TEXT_TIMING_PROBE)
  TaskHandle_t probe_task = xTaskGetCurrentTaskHandle();
  if (xTaskCreate(button_monitor_task, "probe_button", 3072, probe_task,
                  5, NULL) != pdPASS) {
    shutdown_safely();
  }
#ifdef CODEPULSE_EPD_TEXT_TIMING_PROBE
  codepulse_timing_probe_run(APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG);
#elif defined(CODEPULSE_EPD_TEXT_PROBE)
  codepulse_text_probe_run(APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG);
#elif defined(CODEPULSE_EPD_QUIET_PROBE)
  codepulse_quiet_probe_run(APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG);
#elif defined(CODEPULSE_EPD_WAVEFORM_PROBE)
  codepulse_waveform_probe_run(APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG);
#else
  codepulse_window_probe_run(APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG);
#endif
  /* The probe never returns or enters provisioning/network synchronization. */
  idle_safely_forever();
#endif

  const esp_err_t buzzer_init_err = buzzer_init();
  if (buzzer_init_err != ESP_OK) {
    ESP_LOGE(TAG, "buzzer initialization failed: %s",
             esp_err_to_name(buzzer_init_err));
  } else {
    ESP_LOGI(TAG, "buzzer self-test: two 3 kHz short tones");
    const esp_err_t buzzer_test_err = buzzer_play_startup_test();
    if (buzzer_test_err != ESP_OK) {
      ESP_LOGE(TAG, "buzzer self-test failed: %s",
               esp_err_to_name(buzzer_test_err));
    } else {
      ESP_LOGI(TAG, "buzzer self-test output completed");
    }
  }

  TaskHandle_t application_task = xTaskGetCurrentTaskHandle();
  const esp_err_t provisioning_err = codepulse_usb_provisioning_start(
      application_task, APP_NOTIFY_CONFIG_UPDATED);
  if (provisioning_err != ESP_OK) {
    ESP_LOGE(TAG, "USB provisioning service failed: %s",
             esp_err_to_name(provisioning_err));
  }

  if (xTaskCreate(button_monitor_task, "button_monitor", 3072, application_task,
                  5, NULL) != pdPASS) {
    ESP_LOGE(TAG, "button monitor initialization failed");
    shutdown_safely();
  }

  ESP_LOGI(TAG, "panel=WFT0420CZ15 revision=legacy resolution=400x300 "
                "colors=BW quiet=" EPD_QUIET_PROFILE_NAME " busy=active-low");
  ESP_LOGI(TAG,
           "battery_rework=GPIO42_to_GPIO8 adc=ADC1_CH7 divider=200k/100k");
  log_hardware_report();

#ifdef CODEPULSE_EPD_PANEL_READBACK
  /* Owns the uninitialized panel bus exclusively; no normal-app fallthrough. */
  codepulse_panel_readback_run(APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG);
  shutdown_safely();
  idle_safely_forever();
#endif

  epd_canvas_t canvas = {
      .black = s_black_plane,
      .red = s_red_plane,
  };
#ifdef CODEPULSE_EPD_RED_MASK_PROBE
  if (!codepulse_red_mask_run(&canvas, APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG)) {
    shutdown_safely();
  }
#endif
#ifdef CODEPULSE_EPD_RED_BADGE_PROBE
  if (!codepulse_red_badge_run(&canvas, APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG)) {
    shutdown_safely();
  }
#endif
#ifdef CODEPULSE_EPD_RED_LUT5_PROBE
  if (!codepulse_red_lut5_run(&canvas, APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG)) {
    shutdown_safely();
  }
#endif
#ifdef CODEPULSE_EPD_RED_LUT_PROBE
  if (!codepulse_red_lut_run(&canvas, APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG)) {
    shutdown_safely();
  }
#endif
#ifdef CODEPULSE_EPD_RED_REGION_PROBE
  if (!codepulse_red_probe_run(&canvas, APP_NOTIFY_BUTTON_SHORT, APP_NOTIFY_BUTTON_LONG)) {
    shutdown_safely();
  }
#endif
#ifdef CODEPULSE_EPD_RESOLUTION_PROBE
  if (!codepulse_resolution_probe_run(&canvas, APP_NOTIFY_BUTTON_SHORT,
                                     APP_NOTIFY_BUTTON_LONG)) {
    shutdown_safely();
  }
#endif
  aht20_sample_t sample = {0};
  battery_sample_t battery = {0};
  codepulse_device_config_t device_config = {0};
  codepulse_client_t codepulse_client;
  static codepulse_remote_status_t remote_status; /* Includes bounded ambient bitmap; keep off task stack. */

  codepulse_client_init(&codepulse_client);
  codepulse_remote_status_reset(&remote_status);

  bool sensor_ready = false;
  bool battery_ready = false;
  bool sample_valid = read_environment_sample(&sensor_ready, &sample);
  bool battery_valid = read_battery_sample(&battery_ready, &battery);
  uint32_t applied_config_generation =
      codepulse_usb_provisioning_configuration_generation();
  bool network_config_ready = load_network_configuration(&device_config);
  if (network_config_ready) {
    codepulse_usb_provisioning_set_runtime_state(
        CODEPULSE_USB_RUNTIME_APPLYING);
  }
  bool server_reachable =
      network_config_ready &&
      sync_codepulse_status(&device_config, &codepulse_client, &remote_status, 0);
  const esp_err_t audio_err = codepulse_audio_start();
  if (audio_err != ESP_OK) ESP_LOGW(TAG, "optional audio unavailable: %s", esp_err_to_name(audio_err));
  update_usb_runtime_state(applied_config_generation, network_config_ready,
                           server_reachable);

  codepulse_ui_model_t model = make_dashboard_model(
      &sample, sample_valid, &battery, battery_valid, &remote_status,
      server_reachable);

  display_sync_policy_t display_sync = {0};
  int64_t last_sample_ms = esp_timer_get_time() / 1000;
  bool display_ready = false;
  refresh_dashboard(&canvas, &model, &display_ready, &display_sync, false);

  uint32_t notifications = 0;
  xTaskNotifyWait(0, UINT32_MAX, &notifications, 0);
  if ((notifications & APP_NOTIFY_BUTTON_LONG) != 0) {
    shutdown_safely();
  }
  if ((notifications & APP_NOTIFY_BUTTON_SHORT) != 0) {
    ESP_LOGW(TAG, "short press during initial refresh was ignored");
  }
  notifications &= APP_NOTIFY_CONFIG_UPDATED;

  for (;;) {
    if (notifications == 0 &&
        xTaskNotifyWait(0, UINT32_MAX, &notifications,
                        pdMS_TO_TICKS(server_reachable ? CODEPULSE_STATUS_REARM_MS : CODEPULSE_STATUS_RETRY_MS)) != pdTRUE) {
      server_reachable = network_config_ready && sync_codepulse_status(
          &device_config, &codepulse_client, &remote_status, CODEPULSE_STATUS_WATCH_MS);
      update_usb_runtime_state(applied_config_generation, network_config_ready,
                               server_reachable);

      // Handle shutdown/configuration/manual requests before any slow waveform.
      if (xTaskNotifyWait(0, UINT32_MAX, &notifications, 0) == pdTRUE) {
        continue;
      }
      const int64_t sample_now = esp_timer_get_time() / 1000;
      if (sample_now - last_sample_ms >= CODEPULSE_SENSOR_SAMPLE_MS) {
        sample_valid = read_environment_sample(&sensor_ready, &sample);
        battery_valid = read_battery_sample(&battery_ready, &battery);
        last_sample_ms = sample_now;
      }
      model = make_dashboard_model(
          &sample, sample_valid, &battery, battery_valid, &remote_status,
          server_reachable);
      const display_sync_reason_t refresh_reason = display_sync_evaluate(
          &display_sync, esp_timer_get_time() / 1000, &model);
      if (refresh_reason == DISPLAY_SYNC_NONE && !s_manual_sync_pending) {
        continue;
      }
      ESP_LOGI(TAG, "dashboard sync requested reason=%s revision=%s",
               display_sync_reason_name(refresh_reason), remote_status.revision);
      refresh_dashboard(&canvas, &model, &display_ready, &display_sync, false);
      notifications = 0;
      xTaskNotifyWait(0, UINT32_MAX, &notifications, 0);
      if ((notifications & APP_NOTIFY_BUTTON_LONG) != 0) {
        shutdown_safely();
      }
      if ((notifications & APP_NOTIFY_BUTTON_SHORT) != 0) {
        ESP_LOGW(TAG, "short press during automatic refresh was ignored");
      }
      notifications &= APP_NOTIFY_CONFIG_UPDATED;
      continue;
    }

    if ((notifications & APP_NOTIFY_BUTTON_LONG) != 0) {
      shutdown_safely();
    }

    if ((notifications & APP_NOTIFY_CONFIG_UPDATED) != 0) {
      const uint32_t pending_generation =
          codepulse_usb_provisioning_configuration_generation();
      if (pending_generation == applied_config_generation) {
        notifications &= ~APP_NOTIFY_CONFIG_UPDATED;
        continue;
      }
      ESP_LOGI(TAG, "app provisioning update received; applying network "
                    "configuration");
      codepulse_discovery_stop();
      const esp_err_t stop_err = wifi_manager_stop();
      if (stop_err != ESP_OK) {
        ESP_LOGW(TAG, "Wi-Fi stop before reconfiguration failed: %s",
                 esp_err_to_name(stop_err));
      }
      codepulse_client_init(&codepulse_client);
      codepulse_remote_status_reset(&remote_status);
      applied_config_generation = pending_generation;
      network_config_ready = load_network_configuration(&device_config);
      if (network_config_ready) {
        codepulse_usb_provisioning_set_runtime_state(
            CODEPULSE_USB_RUNTIME_APPLYING);
      }
      server_reachable = network_config_ready &&
                         sync_codepulse_status(
                             &device_config, &codepulse_client, &remote_status, 0);
      update_usb_runtime_state(applied_config_generation, network_config_ready,
                               server_reachable);
      sample_valid = read_environment_sample(&sensor_ready, &sample);
      battery_valid = read_battery_sample(&battery_ready, &battery);
      model = make_dashboard_model(
          &sample, sample_valid, &battery, battery_valid, &remote_status,
          server_reachable);

      refresh_dashboard(&canvas, &model, &display_ready, &display_sync, true);

      notifications = 0;
      xTaskNotifyWait(0, UINT32_MAX, &notifications, 0);
      if ((notifications & APP_NOTIFY_BUTTON_LONG) != 0) {
        shutdown_safely();
      }
      if ((notifications & APP_NOTIFY_BUTTON_SHORT) != 0) {
        ESP_LOGW(TAG, "short press during provisioning refresh was ignored");
      }
      notifications &= APP_NOTIFY_CONFIG_UPDATED;
      continue;
    }

    if ((notifications & APP_NOTIFY_BUTTON_SHORT) != 0) {
      ESP_LOGI(TAG, "short press detected; syncing CodePulse and refreshing "
                    "temperature, humidity, and battery");
      sample_valid = read_environment_sample(&sensor_ready, &sample);
      battery_valid = read_battery_sample(&battery_ready, &battery);
      if (network_config_ready) {
        server_reachable = sync_codepulse_status(
            &device_config, &codepulse_client, &remote_status, 0);
      }
      update_usb_runtime_state(applied_config_generation, network_config_ready,
                               server_reachable);
      model = make_dashboard_model(
          &sample, sample_valid, &battery, battery_valid, &remote_status,
          server_reachable);

      refresh_dashboard(&canvas, &model, &display_ready, &display_sync, true);

      notifications = 0;
      xTaskNotifyWait(0, UINT32_MAX, &notifications, 0);
      if ((notifications & APP_NOTIFY_BUTTON_LONG) != 0) {
        shutdown_safely();
      }
      if ((notifications & APP_NOTIFY_BUTTON_SHORT) != 0) {
        ESP_LOGW(TAG, "short press during display refresh was ignored");
      }
      notifications &= APP_NOTIFY_CONFIG_UPDATED;
      continue;
    }

    notifications = 0;
  }
}
