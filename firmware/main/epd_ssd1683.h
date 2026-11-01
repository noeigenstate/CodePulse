#pragma once

#include <stdint.h>

#include "epd_canvas.h"
#include "esp_err.h"

/* Initializes SPI for the legacy WFT0420CZ15 controller. */
esp_err_t epd_ssd1683_init(void);

/*
 * Performs one full B/W/R refresh, then turns off the panel high-voltage
 * supplies while leaving the controller able to accept another refresh.
 * This build uses active-low BUSY and the legacy 0x10/0x13 RAM protocol.
 * Calls are synchronous, so a second refresh cannot overlap the first.
 */
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *canvas,
                              uint32_t *duration_ms);

/* Enters deep sleep immediately before the board power latch is released. */
esp_err_t epd_ssd1683_deep_sleep(void);
