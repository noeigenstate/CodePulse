#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "epd_canvas.h"
#include "esp_err.h"

#define QUIET_BWR_CRISP_FRAMES 300u
#define QUIET_BWR_CLEAR_FRAMES 179u
#define QUIET_BWR_BLACK_FRAMES 151u

#define QUIET_BWR_CRISP_GATE_MS 5200u
#define QUIET_BWR_CLEAR_GATE_MS 3500u
#define QUIET_BWR_BLACK_GATE_MS 3500u

typedef enum {
  QUIET_BWR_PHASE_NONE = 0,
  QUIET_BWR_PHASE_CRISP_RED = 1,
  QUIET_BWR_PHASE_CLEAR_WHITE = 2,
  QUIET_BWR_PHASE_WRITE_BLACK = 3,
} quiet_bwr_phase_t;

typedef struct {
  unsigned x, y, width, height;
  unsigned pass_count;
  quiet_bwr_phase_t passes[2];
  unsigned hold_pixels;
  unsigned changed_white, changed_black, changed_red;
  unsigned red_removed, red_added, red_to_black;
  unsigned old_red_pixels, new_red_pixels;
} quiet_bwr_plan_t;

esp_err_t quiet_bwr_prepare(quiet_bwr_plan_t *plan, const epd_canvas_t *canvas,
                            const uint8_t *old_black, const uint8_t *old_red,
                            size_t size);
unsigned quiet_bwr_pass_frames(quiet_bwr_phase_t phase);
unsigned quiet_bwr_pass_gate_ms(quiet_bwr_phase_t phase);
const char *quiet_bwr_phase_name(quiet_bwr_phase_t phase);
size_t quiet_bwr_make_lut(unsigned table, quiet_bwr_phase_t phase,
                          uint8_t out[44]);
void quiet_bwr_encode_row(quiet_bwr_phase_t phase, unsigned row,
                          const uint8_t *new_black, const uint8_t *new_red,
                          const uint8_t *old_black, const uint8_t *old_red,
                          uint8_t *mask_black_row, uint8_t *mask_red_row);
