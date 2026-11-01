#include "epd_ssd1683.h"

#include <inttypes.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "board_pins.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define EPD_SPI_HOST SPI2_HOST
#define EPD_SPI_HZ 2000000
#define EPD_INIT_TIMEOUT_MS 5000
#define EPD_BUSY_ASSERT_TIMEOUT_MS 1000
#define EPD_BUSY_TIMEOUT_MS 30000
#define EPD_TRANSFER_CHUNK_SIZE 1024

static const char *TAG = "wft0420-old";
static spi_device_handle_t s_spi;
/* Valid only after a successful clean baseline and safe HV shutdown.
 * Reset, sleep or any attempted display failure invalidates this session. */
static bool s_epd_baseline_valid;

static esp_err_t epd_transmit(const uint8_t *data, size_t length,
                              int dc_level) {
  gpio_set_level(PIN_EPD_DC, dc_level);

  while (length > 0) {
    const size_t chunk =
        length > EPD_TRANSFER_CHUNK_SIZE ? EPD_TRANSFER_CHUNK_SIZE : length;
    spi_transaction_t transaction = {
        .length = chunk * 8,
        .tx_buffer = data,
    };
    ESP_RETURN_ON_ERROR(spi_device_polling_transmit(s_spi, &transaction), TAG,
                        "SPI transfer failed");
    data += chunk;
    length -= chunk;
  }

  return ESP_OK;
}

static esp_err_t epd_command(uint8_t command) {
  return epd_transmit(&command, 1, 0);
}

static esp_err_t epd_command_data(uint8_t command, const uint8_t *data,
                                  size_t length) {
  ESP_RETURN_ON_ERROR(epd_command(command), TAG, "command 0x%02x failed",
                      command);
  return length == 0 ? ESP_OK : epd_transmit(data, length, 1);
}

static esp_err_t epd_wait_ready(uint32_t timeout_ms) {
  const int64_t deadline_us = esp_timer_get_time() + (int64_t)timeout_ms * 1000;

  /* Legacy WFT0420CZ15: BUSY is low during an operation and high when idle. */
  do {
    ESP_RETURN_ON_ERROR(epd_command(0x71), TAG, "GET_STATUS failed");
    vTaskDelay(pdMS_TO_TICKS(20));

    if (gpio_get_level(PIN_EPD_BUSY) != 0) {
      vTaskDelay(pdMS_TO_TICKS(20));
      return ESP_OK;
    }

    if (esp_timer_get_time() >= deadline_us) {
      ESP_LOGE(TAG, "BUSY remained low for %" PRIu32 " ms", timeout_ms);
      return ESP_ERR_TIMEOUT;
    }
  } while (true);
}

static esp_err_t epd_wait_refresh_complete(uint32_t timeout_ms) {
  const int64_t started_us = esp_timer_get_time();
  const int64_t busy_assert_deadline_us =
      started_us + (int64_t)EPD_BUSY_ASSERT_TIMEOUT_MS * 1000;
  const int64_t completion_deadline_us =
      started_us + (int64_t)timeout_ms * 1000;
  bool observed_busy = false;

  do {
    ESP_RETURN_ON_ERROR(epd_command(0x71), TAG, "GET_STATUS failed");
    vTaskDelay(pdMS_TO_TICKS(20));

    if (gpio_get_level(PIN_EPD_BUSY) == 0) {
      observed_busy = true;
    } else if (observed_busy) {
      vTaskDelay(pdMS_TO_TICKS(20));
      return ESP_OK;
    } else if (esp_timer_get_time() >= busy_assert_deadline_us) {
      ESP_LOGE(TAG,
               "DISPLAY_REFRESH did not assert BUSY; legacy controller may "
               "still be in deep sleep");
      return ESP_ERR_INVALID_RESPONSE;
    }

    if (esp_timer_get_time() >= completion_deadline_us) {
      ESP_LOGE(TAG, "BUSY remained low for %" PRIu32 " ms", timeout_ms);
      return ESP_ERR_TIMEOUT;
    }
  } while (true);
}

#include "driver_reset.inc"

static esp_err_t epd_panel_wake_and_configure(void) {
  epd_hardware_reset();

  const uint8_t booster_soft_start[] = {0x17, 0x17, 0x17};
  ESP_RETURN_ON_ERROR(
      epd_command_data(0x06, booster_soft_start, sizeof(booster_soft_start)),
      TAG, "BOOSTER_SOFT_START failed");

  ESP_RETURN_ON_ERROR(epd_command(0x04), TAG, "POWER_ON failed");
  ESP_RETURN_ON_ERROR(epd_wait_ready(EPD_INIT_TIMEOUT_MS), TAG,
                      "POWER_ON timed out");

  const uint8_t panel_setting[] = {0x0F};
  ESP_RETURN_ON_ERROR(
      epd_command_data(0x00, panel_setting, sizeof(panel_setting)), TAG,
      "PANEL_SETTING failed");

  return ESP_OK;
}

static esp_err_t epd_power_off(void) {
  esp_err_t result = ESP_OK;

  if (gpio_get_level(PIN_EPD_BUSY) == 0) {
    ESP_LOGE(TAG, "cannot power off panel while BUSY is low");
    result = ESP_ERR_INVALID_STATE;
    goto safe_pins;
  }

  const uint8_t interval_setting[] = {0xF7};
  result = epd_command_data(0x50, interval_setting, sizeof(interval_setting));
  if (result == ESP_OK) {
    result = epd_command(0x02);
  }
  if (result == ESP_OK) {
    result = epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  }
  if (result != ESP_OK) {
    ESP_LOGE(TAG, "legacy panel power-off failed: %s", esp_err_to_name(result));
    goto safe_pins;
  }

safe_pins:
  vTaskDelay(pdMS_TO_TICKS(10));
  gpio_set_level(PIN_EPD_CS, 1);
  gpio_set_level(PIN_EPD_DC, 0);
  return result;
}

esp_err_t epd_ssd1683_init(void) {
  if (s_spi != NULL) {
    return ESP_OK;
  }

  const spi_bus_config_t bus_config = {
      .mosi_io_num = PIN_EPD_MOSI,
      .miso_io_num = -1,
      .sclk_io_num = PIN_EPD_SCLK,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = EPD_TRANSFER_CHUNK_SIZE,
  };
  ESP_RETURN_ON_ERROR(
      spi_bus_initialize(EPD_SPI_HOST, &bus_config, SPI_DMA_CH_AUTO), TAG,
      "SPI bus initialization failed");

  const spi_device_interface_config_t device_config = {
      .clock_speed_hz = EPD_SPI_HZ,
      .mode = 0,
      .spics_io_num = PIN_EPD_CS,
      .queue_size = 1,
  };

  esp_err_t err = spi_bus_add_device(EPD_SPI_HOST, &device_config, &s_spi);
  if (err != ESP_OK) {
    spi_bus_free(EPD_SPI_HOST);
    return err;
  }

  ESP_LOGI(TAG, "legacy tri-color SPI ready at %d Hz (BUSY low=busy)",
           EPD_SPI_HZ);
  return ESP_OK;
}

esp_err_t epd_ssd1683_refresh(const epd_canvas_t *canvas,
                              uint32_t *duration_ms) {
  if (canvas == NULL || canvas->black == NULL || canvas->red == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (s_spi == NULL) {
    return ESP_ERR_INVALID_STATE;
  }

  s_epd_baseline_valid = false;
  const int64_t started_us = esp_timer_get_time();
  esp_err_t result = epd_panel_wake_and_configure();
  if (result == ESP_OK) {
    result = epd_command_data(0x10, canvas->black, EPD_CANVAS_BUFFER_SIZE);
  }
  if (result == ESP_OK) {
    /* Legacy 0x13 RAM uses a cleared bit for a red pixel. */
    result = epd_command_data(0x13, canvas->red, EPD_CANVAS_BUFFER_SIZE);
  }
  if (result == ESP_OK) {
    result = epd_command(0x12);
  }
  if (result == ESP_OK) {
    vTaskDelay(pdMS_TO_TICKS(100));
    result = epd_wait_refresh_complete(EPD_BUSY_TIMEOUT_MS);
  }

  const esp_err_t power_off_result = epd_power_off();
  if (result == ESP_OK) {
    result = power_off_result;
  }

  const uint32_t elapsed_ms =
      (uint32_t)((esp_timer_get_time() - started_us) / 1000);
  if (duration_ms != NULL) {
    *duration_ms = elapsed_ms;
  }

  s_epd_baseline_valid = result == ESP_OK;
  if (result == ESP_OK) {
    ESP_LOGI(TAG, "full B/W/R refresh completed in %" PRIu32 " ms", elapsed_ms);
  } else {
    ESP_LOGE(TAG, "refresh failed after %" PRIu32 " ms: %s", elapsed_ms,
             esp_err_to_name(result));
  }
  return result;
}

esp_err_t epd_ssd1683_deep_sleep(void) {
  s_epd_baseline_valid = false;
  if (s_spi == NULL) {
    return ESP_OK;
  }

  if (gpio_get_level(PIN_EPD_BUSY) == 0) {
    ESP_LOGE(TAG, "cannot enter deep sleep while BUSY is low");
    return ESP_ERR_INVALID_STATE;
  }

  const uint8_t deep_sleep_check[] = {0xA5};
  const esp_err_t result =
      epd_command_data(0x07, deep_sleep_check, sizeof(deep_sleep_check));
  if (result == ESP_OK) {
    ESP_LOGI(TAG, "legacy panel entered deep sleep for board shutdown");
  } else {
    ESP_LOGE(TAG, "legacy panel deep sleep failed: %s",
             esp_err_to_name(result));
  }

  vTaskDelay(pdMS_TO_TICKS(20));
  gpio_set_level(PIN_EPD_CS, 1);
  gpio_set_level(PIN_EPD_DC, 0);
  return result;
}

#ifdef CODEPULSE_EPD_WINDOW_PROBE
#include "../experiments/epd-window-probe/driver_window.inc"
#endif
#ifdef CODEPULSE_EPD_WAVEFORM_PROBE
#include "../experiments/epd-waveform-probe/driver_waveform.inc"
#endif
#if defined(CODEPULSE_EPD_QUIET_PROBE) || defined(CODEPULSE_EPD_TEXT_PROBE)
#include "../experiments/epd-quiet-probe/driver_quiet.inc"
#endif

#ifdef CODEPULSE_EPD_TEXT_TIMING_PROBE
#include "../experiments/epd-text-timing-probe/driver_timing.inc"
#endif

#include "driver_quiet.inc"
