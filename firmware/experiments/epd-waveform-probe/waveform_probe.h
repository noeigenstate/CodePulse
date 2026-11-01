#pragma once
#include <stdint.h>
#include "esp_err.h"
#include "epd_canvas.h"

/* 1 = full reference, 2 = fewer repeats, 3 = zero-drive; never OTP writes. */
esp_err_t epd_waveform_probe_refresh(const epd_canvas_t *canvas, unsigned profile,
                                     uint32_t *duration_ms);
void codepulse_waveform_probe_run(uint32_t short_event, uint32_t long_event);
