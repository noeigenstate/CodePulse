#pragma once
#include "codepulse_ui.h"
#include "epd_quiet.h"

#define CODEPULSE_RED_FULL_COOLDOWN_MS 120000

typedef struct {
  bool initialized;
  bool faulted;
  bool previous_has_red, has_runtime_full;
  uint32_t red_checksum;
  int64_t last_full_ms;
  uint8_t previous[EPD_CANVAS_BUFFER_SIZE];
} quiet_dashboard_t;

typedef struct {
  bool full, changed, red_full;
  unsigned y, height;
  epd_quiet_metrics_t timing;
} quiet_dashboard_result_t;

void quiet_dashboard_render(epd_canvas_t *canvas, const codepulse_ui_model_t *model);
/* A failed transfer invalidates optical history and latches a fault. It never
 * retries or silently falls back to a full refresh. Reboot is the clean path. */
esp_err_t quiet_dashboard_update(quiet_dashboard_t *state, epd_canvas_t *canvas,
    const codepulse_ui_model_t *model, int64_t now_ms, quiet_dashboard_result_t *result);
