#pragma once

#include <stdbool.h>

#include "esp_err.h"

/* Must be the first board-level call made by app_main(). */
esp_err_t board_power_hold_early(void);

/* Releases the Rev A power latch. Execution may stop immediately afterward. */
esp_err_t board_power_release(void);

/* Establishes safe, non-refreshing GPIO levels. Does not install an SPI bus. */
esp_err_t board_safe_gpio_init(void);

/* Controls the active-high status LED after safe GPIO initialization. */
esp_err_t board_status_led_set(bool on);

/* Checks only pins driven by this bring-up image; it does not touch the EPD. */
bool board_safe_gpio_levels_ok(void);
