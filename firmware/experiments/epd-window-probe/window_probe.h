#pragma once
#include <stdint.h>
#include "esp_err.h"
#include "epd_canvas.h"

/* Experimental OTP-only full-width window; production builds exclude it. */
esp_err_t epd_window_probe_refresh(const epd_canvas_t *canvas,
                                   uint32_t *duration_ms);
void codepulse_window_probe_run(uint32_t short_event, uint32_t long_event);
