#include "aht20.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "board_pins.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define AHT20_ADDRESS 0x38
#define AHT20_I2C_TIMEOUT_MS 100
#define AHT20_MEASUREMENT_TIMEOUT_MS 200

static const char *TAG = "aht20";
static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_device;

static void aht20_cleanup(void) {
  if (s_device != NULL) {
    i2c_master_bus_rm_device(s_device);
    s_device = NULL;
  }
  if (s_bus != NULL) {
    i2c_del_master_bus(s_bus);
    s_bus = NULL;
  }
}

static uint8_t aht20_crc8(const uint8_t *data, size_t length) {
  uint8_t crc = 0xFF;

  for (size_t i = 0; i < length; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x80U) != 0 ? (uint8_t)((crc << 1) ^ 0x31U)
                               : (uint8_t)(crc << 1);
    }
  }

  return crc;
}

static esp_err_t aht20_read_status(uint8_t *status) {
  const uint8_t command = 0x71;
  return i2c_master_transmit_receive(s_device, &command, 1, status, 1,
                                     AHT20_I2C_TIMEOUT_MS);
}

esp_err_t aht20_init(void) {
  if (s_device != NULL) {
    return ESP_OK;
  }

  const i2c_master_bus_config_t bus_config = {
      .i2c_port = I2C_NUM_0,
      .sda_io_num = PIN_I2C_SDA,
      .scl_io_num = PIN_I2C_SCL,
      .clk_source = I2C_CLK_SRC_DEFAULT,
      .glitch_ignore_cnt = 7,
      .flags.enable_internal_pullup = false,
  };
  ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_config, &s_bus), TAG,
                      "I2C bus initialization failed");

  const i2c_device_config_t device_config = {
      .dev_addr_length = I2C_ADDR_BIT_LEN_7,
      .device_address = AHT20_ADDRESS,
      .scl_speed_hz = 100000,
  };

  esp_err_t err = i2c_master_bus_add_device(s_bus, &device_config, &s_device);
  if (err != ESP_OK) {
    i2c_del_master_bus(s_bus);
    s_bus = NULL;
    return err;
  }

  vTaskDelay(pdMS_TO_TICKS(100));

  uint8_t status = 0;
  err = aht20_read_status(&status);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "sensor did not respond at I2C address 0x%02x",
             AHT20_ADDRESS);
    aht20_cleanup();
    return err;
  }

  if ((status & 0x08U) == 0) {
    const uint8_t initialize[] = {0xBE, 0x08, 0x00};
    err = i2c_master_transmit(s_device, initialize, sizeof(initialize),
                              AHT20_I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "calibration initialization failed: %s",
               esp_err_to_name(err));
      aht20_cleanup();
      return err;
    }
    vTaskDelay(pdMS_TO_TICKS(10));

    err = aht20_read_status(&status);
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "status read failed after calibration: %s",
               esp_err_to_name(err));
      aht20_cleanup();
      return err;
    }
    if ((status & 0x08U) == 0) {
      ESP_LOGE(TAG, "sensor calibration bit is not set (status=0x%02x)",
               status);
      aht20_cleanup();
      return ESP_ERR_INVALID_RESPONSE;
    }
  }

  ESP_LOGI(TAG, "AHT20 ready at 0x%02x (status=0x%02x)", AHT20_ADDRESS, status);
  return ESP_OK;
}

esp_err_t aht20_read(aht20_sample_t *sample) {
  if (sample == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (s_device == NULL) {
    return ESP_ERR_INVALID_STATE;
  }

  const uint8_t trigger[] = {0xAC, 0x33, 0x00};
  ESP_RETURN_ON_ERROR(i2c_master_transmit(s_device, trigger, sizeof(trigger),
                                          AHT20_I2C_TIMEOUT_MS),
                      TAG, "measurement trigger failed");

  vTaskDelay(pdMS_TO_TICKS(80));

  uint8_t data[7] = {0};
  const TickType_t deadline =
      xTaskGetTickCount() + pdMS_TO_TICKS(AHT20_MEASUREMENT_TIMEOUT_MS);
  do {
    ESP_RETURN_ON_ERROR(
        i2c_master_receive(s_device, data, sizeof(data), AHT20_I2C_TIMEOUT_MS),
        TAG, "measurement read failed");
    if ((data[0] & 0x80U) == 0) {
      break;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  } while ((int32_t)(deadline - xTaskGetTickCount()) > 0);

  if ((data[0] & 0x80U) != 0) {
    return ESP_ERR_TIMEOUT;
  }
  if ((data[0] & 0x08U) == 0) {
    return ESP_ERR_INVALID_STATE;
  }
  if (aht20_crc8(data, 6) != data[6]) {
    ESP_LOGE(TAG, "CRC mismatch: calculated=0x%02x received=0x%02x",
             aht20_crc8(data, 6), data[6]);
    return ESP_ERR_INVALID_CRC;
  }

  const uint32_t humidity_raw = ((uint32_t)data[1] << 12) |
                                ((uint32_t)data[2] << 4) |
                                ((uint32_t)data[3] >> 4);
  const uint32_t temperature_raw =
      (((uint32_t)data[3] & 0x0FU) << 16) | ((uint32_t)data[4] << 8) | data[5];

  sample->humidity_rh = (float)humidity_raw * 100.0F / 1048576.0F;
  sample->temperature_c = (float)temperature_raw * 200.0F / 1048576.0F - 50.0F;

  if (sample->temperature_c < -40.0F || sample->temperature_c > 85.0F ||
      sample->humidity_rh < 0.0F || sample->humidity_rh > 100.0F) {
    ESP_LOGE(TAG, "sample outside valid range: %.2f C, %.2f %%RH",
             sample->temperature_c, sample->humidity_rh);
    return ESP_ERR_INVALID_RESPONSE;
  }

  return ESP_OK;
}
