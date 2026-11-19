#pragma once
#include "esp_err.h"
#define GPIO_NUM_4 4
#define GPIO_NUM_5 5
#define GPIO_NUM_6 6
#define GPIO_NUM_7 7
#define GPIO_NUM_16 16
#define GPIO_NUM_17 17
#define GPIO_MODE_INPUT 1
#define GPIO_MODE_INPUT_OUTPUT 3
#define GPIO_FLOATING 0
esp_err_t gpio_set_level(int pin,int level);
esp_err_t gpio_set_direction(int pin,int mode);
esp_err_t gpio_set_pull_mode(int pin,int mode);
int gpio_get_level(int pin);
