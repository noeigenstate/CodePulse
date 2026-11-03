#pragma once
#include "codepulse_life.h"
#include "epd_canvas.h"

/* False means untouched canvas: the caller must render the existing legacy text card. */
bool life_dashboard_render(epd_canvas_t *canvas, const codepulse_life_t *life);
