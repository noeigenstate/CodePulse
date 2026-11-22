#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "epd_canvas.h"
bool codepulse_resolution_probe_run(epd_canvas_t *canvas,
                                   uint32_t short_event, uint32_t long_event);
