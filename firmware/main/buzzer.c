#include "buzzer.h"

#include <stdbool.h>
#include <stdint.h>

#include "board_pins.h"
#include "driver/ledc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define BUZZER_FREQUENCY_HZ 3000U
#define BUZZER_DUTY_RESOLUTION LEDC_TIMER_10_BIT
#define BUZZER_HALF_DUTY 512U
#define BUZZER_TONE_DURATION_MS 150U
#define BUZZER_TONE_GAP_MS 100U

#define BUZZER_LEDC_MODE LEDC_LOW_SPEED_MODE
#define BUZZER_LEDC_TIMER LEDC_TIMER_0
#define BUZZER_LEDC_CHANNEL LEDC_CHANNEL_0

static bool s_initialized;

esp_err_t buzzer_init(void) {
  if (s_initialized) {
    return ESP_OK;
  }

  const ledc_timer_config_t timer_config = {
      .speed_mode = BUZZER_LEDC_MODE,
      .duty_resolution = BUZZER_DUTY_RESOLUTION,
      .timer_num = BUZZER_LEDC_TIMER,
      .freq_hz = BUZZER_FREQUENCY_HZ,
      .clk_cfg = LEDC_AUTO_CLK,
  };
  esp_err_t err = ledc_timer_config(&timer_config);
  if (err != ESP_OK) {
    return err;
  }

  const ledc_channel_config_t channel_config = {
      .gpio_num = PIN_BUZZER,
      .speed_mode = BUZZER_LEDC_MODE,
      .channel = BUZZER_LEDC_CHANNEL,
      .timer_sel = BUZZER_LEDC_TIMER,
      .duty = 0,
      .hpoint = 0,
      .sleep_mode = LEDC_SLEEP_MODE_NO_ALIVE_NO_PD,
      .flags.output_invert = 0,
  };
  err = ledc_channel_config(&channel_config);
  if (err != ESP_OK) {
    return err;
  }

  s_initialized = true;
  return buzzer_stop();
}

esp_err_t buzzer_stop(void) {
  if (!s_initialized) {
    return ESP_OK;
  }
  return ledc_stop(BUZZER_LEDC_MODE, BUZZER_LEDC_CHANNEL, 0);
}

static esp_err_t buzzer_tone(uint32_t duration_ms) {
  esp_err_t err =
      ledc_set_duty(BUZZER_LEDC_MODE, BUZZER_LEDC_CHANNEL, BUZZER_HALF_DUTY);
  if (err == ESP_OK) {
    err = ledc_update_duty(BUZZER_LEDC_MODE, BUZZER_LEDC_CHANNEL);
  }
  if (err != ESP_OK) {
    buzzer_stop();
    return err;
  }

  vTaskDelay(pdMS_TO_TICKS(duration_ms));
  return buzzer_stop();
}

esp_err_t buzzer_play_startup_test(void) {
  if (!s_initialized) {
    return ESP_ERR_INVALID_STATE;
  }

  esp_err_t err = buzzer_tone(BUZZER_TONE_DURATION_MS);
  if (err != ESP_OK) {
    return err;
  }

  vTaskDelay(pdMS_TO_TICKS(BUZZER_TONE_GAP_MS));
  return buzzer_tone(BUZZER_TONE_DURATION_MS);
}
