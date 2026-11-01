#include "board_safety.h"

#include <stdint.h>

#include "board_pins.h"
#include "driver/gpio.h"

static esp_err_t preload_output_level(gpio_num_t pin, uint32_t level) {
  esp_err_t err = gpio_set_level(pin, level);
  if (err != ESP_OK) {
    return err;
  }

  /* Keep the input buffer enabled so safety checks read the physical pad. */
  return gpio_set_direction(pin, GPIO_MODE_INPUT_OUTPUT);
}

esp_err_t board_power_hold_early(void) {
  /*
   * Load the output latch before enabling the output driver. This avoids a
   * deliberate low pulse on PWR_HOLD while the user is holding the power
   * button through boot.
   */
  return preload_output_level(PIN_PWR_HOLD, 1);
}

esp_err_t board_power_release(void) { return gpio_set_level(PIN_PWR_HOLD, 0); }

esp_err_t board_safe_gpio_init(void) {
  static const struct {
    gpio_num_t pin;
    uint32_t level;
  } outputs[] = {
      {PIN_PWR_HOLD, 1},   {PIN_EPD_CS, 1},   {PIN_EPD_RST, 1},
      {PIN_EPD_DC, 0},     {PIN_EPD_SCLK, 0}, {PIN_EPD_MOSI, 0},
      {PIN_STATUS_LED, 0}, {PIN_BUZZER, 0},
  };

  for (size_t i = 0; i < sizeof(outputs) / sizeof(outputs[0]); ++i) {
    esp_err_t err = preload_output_level(outputs[i].pin, outputs[i].level);
    if (err != ESP_OK) {
      return err;
    }
  }

  const gpio_config_t input_config = {
      .pin_bit_mask = (1ULL << PIN_EPD_BUSY) | (1ULL << PIN_BUTTON) |
                      (1ULL << PIN_BAT_ADC_ORIGINAL) | (1ULL << PIN_BAT_ADC),
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };

  return gpio_config(&input_config);
}

esp_err_t board_status_led_set(bool on) {
  return gpio_set_level(PIN_STATUS_LED, on ? 1 : 0);
}

bool board_safe_gpio_levels_ok(void) {
  return gpio_get_level(PIN_PWR_HOLD) == 1 && gpio_get_level(PIN_EPD_CS) == 1 &&
         gpio_get_level(PIN_EPD_RST) == 1 && gpio_get_level(PIN_EPD_DC) == 0 &&
         gpio_get_level(PIN_EPD_SCLK) == 0 &&
         gpio_get_level(PIN_EPD_MOSI) == 0 &&
         gpio_get_level(PIN_STATUS_LED) == 0 && gpio_get_level(PIN_BUZZER) == 0;
}
