#include "quiet_bwr_plan.h"

#include <string.h>

#define ROW_BYTES (BOARD_EPD_WIDTH / 8u)

static unsigned popcount8(uint8_t value) {
  unsigned count = 0;
  for (; value != 0u; value &= (uint8_t)(value - 1u)) {
    ++count;
  }
  return count;
}

static uint8_t added_red_byte(size_t index, const uint8_t *new_black,
                              const uint8_t *new_red, const uint8_t *old_black,
                              const uint8_t *old_red) {
  const uint8_t changed = (uint8_t)((new_black[index] ^ old_black[index]) |
                                    (new_red[index] ^ old_red[index]));
  return (uint8_t)(changed & (uint8_t)~new_red[index]);
}

static uint8_t added_row_dilate(unsigned row, unsigned col,
                                const uint8_t *new_black,
                                const uint8_t *new_red,
                                const uint8_t *old_black,
                                const uint8_t *old_red) {
  const size_t base = (size_t)row * ROW_BYTES;
  const unsigned cur = added_red_byte(base + col, new_black, new_red, old_black, old_red);
  const unsigned prev =
      col > 0u ? added_red_byte(base + col - 1u, new_black, new_red, old_black, old_red) : 0u;
  const unsigned next =
      col + 1u < ROW_BYTES
          ? added_red_byte(base + col + 1u, new_black, new_red, old_black, old_red)
          : 0u;
  unsigned dilated = cur;
  for (unsigned k = 1u; k <= 3u; ++k) {
    dilated |= ((cur << k) | (next >> (8u - k))) & 0xFFu;
    dilated |= ((cur >> k) | (prev << (8u - k))) & 0xFFu;
  }
  return (uint8_t)dilated;
}

esp_err_t quiet_bwr_prepare(quiet_bwr_plan_t *plan, const epd_canvas_t *canvas,
                            const uint8_t *old_black, const uint8_t *old_red,
                            size_t size) {
  if (plan != NULL) {
    memset(plan, 0, sizeof(*plan));
  }
  if (plan == NULL || canvas == NULL || canvas->black == NULL ||
      canvas->red == NULL || old_black == NULL || old_red == NULL ||
      canvas->black == canvas->red || old_black == old_red ||
      canvas->black == old_black || canvas->black == old_red ||
      canvas->red == old_black || canvas->red == old_red ||
      size != EPD_CANVAS_BUFFER_SIZE) {
    return ESP_ERR_INVALID_ARG;
  }

  quiet_bwr_plan_t selected = {0};
  unsigned first_col = ROW_BYTES, end_col = 0u;
  unsigned first_row = BOARD_EPD_HEIGHT, end_row = 0u;
  bool any_changed = false;

  for (unsigned row = 0u; row < BOARD_EPD_HEIGHT; ++row) {
    for (unsigned col = 0u; col < ROW_BYTES; ++col) {
      const size_t i = (size_t)row * ROW_BYTES + col;
      const uint8_t nb = canvas->black[i];
      const uint8_t nr = canvas->red[i];
      const uint8_t ob = old_black[i];
      const uint8_t or_ = old_red[i];
      if (((uint8_t)~nb & (uint8_t)~nr) != 0u ||
          ((uint8_t)~ob & (uint8_t)~or_) != 0u) {
        return ESP_ERR_INVALID_ARG;
      }

      const uint8_t old_is_red = (uint8_t)~or_;
      const uint8_t new_is_red = (uint8_t)~nr;
      const uint8_t old_is_black = (uint8_t)(or_ & (uint8_t)~ob);
      const uint8_t new_is_black = (uint8_t)(nr & (uint8_t)~nb);
      const uint8_t old_is_white = (uint8_t)(ob & or_);
      const uint8_t new_is_white = (uint8_t)(nb & nr);

      selected.old_red_pixels += popcount8(old_is_red);
      selected.new_red_pixels += popcount8(new_is_red);

      const uint8_t changed = (uint8_t)((nb ^ ob) | (nr ^ or_));
      if (changed == 0u) {
        selected.hold_pixels += 8u;
        continue;
      }

      any_changed = true;
      if (col < first_col) first_col = col;
      if (col + 1u > end_col) end_col = col + 1u;
      if (row < first_row) first_row = row;
      if (row + 1u > end_row) end_row = row + 1u;

      selected.hold_pixels += 8u - popcount8(changed);
      selected.changed_white += popcount8((uint8_t)(changed & new_is_white));
      selected.changed_black += popcount8((uint8_t)(changed & new_is_black));
      selected.changed_red += popcount8((uint8_t)(changed & new_is_red));
      selected.red_removed += popcount8((uint8_t)(old_is_red & (uint8_t)~new_is_red));
      selected.red_added += popcount8((uint8_t)(new_is_red & (uint8_t)~old_is_red));
      selected.red_to_black += popcount8((uint8_t)(old_is_red & new_is_black));
      (void)old_is_black;
      (void)old_is_white;
    }
  }

  if (!any_changed ||
      (selected.old_red_pixels == 0u && selected.new_red_pixels == 0u)) {
    return ESP_ERR_INVALID_ARG;
  }

  /* UC8176 R90 requires HRED > HRST (>= 16 px wide) and VRED > VRST (>= 2 rows). */
  if (end_col - first_col == 1u) {
    if (end_col < ROW_BYTES) ++end_col;
    else --first_col;
  }
  if (end_row - first_row == 1u) {
    if (end_row < BOARD_EPD_HEIGHT) ++end_row;
    else --first_row;
  }

  selected.x = first_col * 8u;
  selected.width = (end_col - first_col) * 8u;
  selected.y = first_row;
  selected.height = end_row - first_row;

  if (selected.changed_red > 0u) {
    selected.passes[0] = QUIET_BWR_PHASE_CRISP_RED;
    if (selected.changed_black > 0u) {
      selected.passes[1] = QUIET_BWR_PHASE_WRITE_BLACK;
      selected.pass_count = 2u;
    } else {
      selected.pass_count = 1u;
    }
  } else if (selected.changed_white > 0u || selected.red_to_black > 0u) {
    selected.passes[0] = QUIET_BWR_PHASE_CLEAR_WHITE;
    if (selected.changed_black > 0u) {
      selected.passes[1] = QUIET_BWR_PHASE_WRITE_BLACK;
      selected.pass_count = 2u;
    } else {
      selected.pass_count = 1u;
    }
  } else {
    selected.passes[0] = QUIET_BWR_PHASE_WRITE_BLACK;
    selected.pass_count = 1u;
  }

  *plan = selected;
  return ESP_OK;
}

unsigned quiet_bwr_pass_frames(quiet_bwr_phase_t phase) {
  switch (phase) {
    case QUIET_BWR_PHASE_CRISP_RED: return QUIET_BWR_CRISP_FRAMES;
    case QUIET_BWR_PHASE_CLEAR_WHITE: return QUIET_BWR_CLEAR_FRAMES;
    case QUIET_BWR_PHASE_WRITE_BLACK: return QUIET_BWR_BLACK_FRAMES;
    default: return 0u;
  }
}

unsigned quiet_bwr_pass_gate_ms(quiet_bwr_phase_t phase) {
  switch (phase) {
    case QUIET_BWR_PHASE_CRISP_RED: return QUIET_BWR_CRISP_GATE_MS;
    case QUIET_BWR_PHASE_CLEAR_WHITE: return QUIET_BWR_CLEAR_GATE_MS;
    case QUIET_BWR_PHASE_WRITE_BLACK: return QUIET_BWR_BLACK_GATE_MS;
    default: return 0u;
  }
}

const char *quiet_bwr_phase_name(quiet_bwr_phase_t phase) {
  switch (phase) {
    case QUIET_BWR_PHASE_CRISP_RED: return "CRISP_860_A";
    case QUIET_BWR_PHASE_CLEAR_WHITE: return "CLEAR_WHITE";
    case QUIET_BWR_PHASE_WRITE_BLACK: return "WRITE_BLACK";
    default: return "NONE";
  }
}

size_t quiet_bwr_make_lut(unsigned table, quiet_bwr_phase_t phase,
                          uint8_t out[44]) {
  if (table >= 5u || out == NULL || quiet_bwr_pass_frames(phase) == 0u) {
    return 0u;
  }
  memset(out, 0, 44u);

  if (phase == QUIET_BWR_PHASE_CRISP_RED) {
    /* Selected .67 Group A (CRISP_860_A) 100 Hz single-pass R22 + R24 waveform:
     * 300 frames total, 32 tail VDL pulses + 860 ms final VDHR hold. */
    static const uint8_t single_a[7][6] = {
        {0xa0, 14, 14, 2, 0, 1}, {0x90, 5, 6, 1, 0, 1},
        {0xb0, 1, 4, 0, 0, 8},   {0xbb, 1, 4, 1, 5, 6},
        {0xbb, 1, 4, 1, 5, 6},   {0xc0, 50, 0, 0, 0, 1},
        {0xc0, 36, 0, 0, 0, 1},
    };
    static const uint8_t white_a[7] = {0xa0, 0xa0, 0x80, 0x00,
                                       0xaa, 0x80, 0x80};
    for (unsigned group = 0u; group < 7u; ++group) {
      out[group * 6u] =
          table == 2u ? single_a[group][0] : (table == 4u ? white_a[group] : 0u);
      memcpy(out + group * 6u + 1u, single_a[group] + 1u, 5u);
    }
    return table != 0u ? 42u : 44u;
  }

  if (table == 4u) {
    out[0] = (phase == QUIET_BWR_PHASE_CLEAR_WHITE) ? 0x80u : 0x40u;
  }
  out[1] = (uint8_t)(quiet_bwr_pass_frames(phase) - 1u);
  out[3] = 1u;
  out[5] = 1u;
  return table != 0u ? 42u : 44u;
}

void quiet_bwr_encode_row(quiet_bwr_phase_t phase, unsigned row,
                          const uint8_t *new_black, const uint8_t *new_red,
                          const uint8_t *old_black, const uint8_t *old_red,
                          uint8_t *mask_black_row, uint8_t *mask_red_row) {
  if (row >= BOARD_EPD_HEIGHT || new_black == NULL || new_red == NULL ||
      old_black == NULL || old_red == NULL || mask_black_row == NULL ||
      mask_red_row == NULL) {
    return;
  }
  const size_t base = (size_t)row * ROW_BYTES;
  const unsigned r_min = row > 3u ? row - 3u : 0u;
  const unsigned r_max =
      row + 3u < BOARD_EPD_HEIGHT ? row + 3u : BOARD_EPD_HEIGHT - 1u;

  for (unsigned col = 0u; col < ROW_BYTES; ++col) {
    const size_t i = base + col;
    const uint8_t nb = new_black[i];
    const uint8_t nr = new_red[i];
    const uint8_t ob = old_black[i];
    const uint8_t or_ = old_red[i];
    const uint8_t changed = (uint8_t)((nb ^ ob) | (nr ^ or_));

    if (phase == QUIET_BWR_PHASE_CRISP_RED) {
      uint8_t near_new_red = 0u;
      for (unsigned r = r_min; r <= r_max; ++r) {
        near_new_red |=
            added_row_dilate(r, col, new_black, new_red, old_black, old_red);
      }
      const uint8_t r22_mask = (uint8_t)(changed & (uint8_t)~nr);
      const uint8_t r24_mask = (uint8_t)(
          (changed & nb & nr) | ((uint8_t)~or_ & (uint8_t)~nb & nr) |
          ((uint8_t)~changed & nb & nr & near_new_red));
      mask_black_row[col] = (uint8_t)~r24_mask;
      mask_red_row[col] = (uint8_t)~r22_mask;
    } else if (phase == QUIET_BWR_PHASE_CLEAR_WHITE) {
      mask_black_row[col] = (uint8_t)~changed;
      mask_red_row[col] = 0xFFu;
    } else if (phase == QUIET_BWR_PHASE_WRITE_BLACK) {
      const uint8_t active = (uint8_t)(changed & nr & (uint8_t)~nb);
      mask_black_row[col] = (uint8_t)~active;
      mask_red_row[col] = 0xFFu;
    } else {
      mask_black_row[col] = 0xFFu;
      mask_red_row[col] = 0xFFu;
    }
  }
}
