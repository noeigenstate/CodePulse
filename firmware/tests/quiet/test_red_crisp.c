/* Whole-driver + dashboard host tests for Board1 dynamic BWR (.67A Crisp + .43 Erase).
 * Verifies SPI/register protocol, LUT bytes, PT_SCAN=1, 3px glyph holes, fault paths,
 * and quiet_dashboard routing. Does not simulate electrophoretic optics. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../test_check.h"
#include "panel_host.h"

#ifndef CODEPULSE_QUIET_PAIR150_TRIAL
#define CODEPULSE_QUIET_PAIR150_TRIAL 1
#endif
#ifndef CODEPULSE_QUIET_RECT_TRIAL
#define CODEPULSE_QUIET_RECT_TRIAL 1
#endif
#ifndef CODEPULSE_QUIET_RED_CRISP_TRIAL
#define CODEPULSE_QUIET_RED_CRISP_TRIAL 1
#endif

#include "../../main/epd_ssd1683.c"
#include "display_sync_policy.h"
#include "display_text.h"
#include "quiet_dashboard.h"

#define FRAME_BYTES EPD_CANVAS_BUFFER_SIZE

static int64_t now_us, busy_until;
static int dc_level = -1, cs_level = -1;
static uint8_t current_cmd, psr_reg, pll_reg, cdi_reg, calibration_marker;
static bool partial_mode, stuck_power, stuck_refresh, no_busy_refresh, stuck_off;
static bool slow_pass[2];
static unsigned spi_calls, fail_at, resets, clean_drives, quiet_bw_drives, bwr_drives, power_offs;
static unsigned pll_writes, cdi_writes, lut_tables_loaded, bwr_pass_seen;
static unsigned last_pt_scan, last_win_x, last_win_y, last_win_w, last_win_h;
static quiet_bwr_phase_t pass_phases_seen[4];
static uint8_t captured_luts[4][5][44];
static uint8_t captured_ram0[4][FRAME_BYTES], captured_ram1[4][FRAME_BYTES];
static uint8_t active_ram[2][FRAME_BYTES];
static size_t uploaded_bytes[2], ram_cursor;
static uint8_t panel_black[FRAME_BYTES], panel_red[FRAME_BYTES];

static bool px_ink(const uint8_t *plane, unsigned x, unsigned y) {
  return (plane[y * 50u + x / 8u] & (uint8_t)(0x80u >> (x % 8u))) == 0u;
}
static void set_px(uint8_t *b, uint8_t *r, unsigned x, unsigned y, epd_color_t color) {
  epd_canvas_t c = {.black = b, .red = r};
  epd_canvas_pixel(&c, (int)x, (int)y, color);
}
static void clear_planes(uint8_t *b, uint8_t *r) {
  memset(b, 0xFF, FRAME_BYTES);
  memset(r, 0xFF, FRAME_BYTES);
}
static uint8_t lut_selector_for_f7(bool mr_bit, bool mb_bit) {
  /* CDI=0xF7 -> DDX11: {mr,mb} 11->0x23 HOLD, 10->0x24 WHITE/ERASE/BLACK, 01->0x22 RED */
  const uint8_t map[4] = {0x22u, 0x22u, 0x24u, 0x23u};
  return map[(mr_bit ? 2u : 0u) + (mb_bit ? 1u : 0u)];
}
static unsigned lut_total_frames(const uint8_t *lut) {
  unsigned sum = 0u;
  for (unsigned g = 0u; g < 7u; ++g) {
    sum += ((unsigned)lut[g * 6u + 1u] + lut[g * 6u + 2u] +
            lut[g * 6u + 3u] + lut[g * 6u + 4u]) *
           (unsigned)lut[g * 6u + 5u];
  }
  return sum;
}

int64_t esp_timer_get_time(void) { return now_us; }
void vTaskDelay(int ticks) { now_us += (int64_t)ticks * 10000; }
void esp_rom_delay_us(uint32_t us) { now_us += us; }
int gpio_get_level(int pin) {
  CHECK(pin == PIN_EPD_BUSY);
  return now_us >= busy_until ? 1 : 0;
}
void gpio_set_level(int pin, int level) {
  if (pin == PIN_EPD_DC) dc_level = level;
  else if (pin == PIN_EPD_CS) cs_level = level;
  else if (pin == PIN_EPD_RST && level == 0) {
    ++resets;
    psr_reg = 0x0Fu;
    pll_reg = 0x3Cu;
    cdi_reg = 0xD7u;
    calibration_marker = 0u;
    partial_mode = false;
    memset(active_ram, 0xFF, sizeof(active_ram));
  }
}
esp_err_t spi_bus_initialize(int host, const spi_bus_config_t *cfg, int dma) {
  CHECK(host == SPI2_HOST && cfg != NULL && cfg->miso_io_num == -1 &&
        dma == SPI_DMA_CH_AUTO);
  return ESP_OK;
}
esp_err_t spi_bus_add_device(int host, const spi_device_interface_config_t *cfg,
                             spi_device_handle_t *out) {
  CHECK(host == SPI2_HOST && cfg != NULL && cfg->clock_speed_hz == 2000000 && out != NULL);
  *out = (void *)1;
  return ESP_OK;
}
esp_err_t spi_bus_free(int host) {
  CHECK(host == SPI2_HOST);
  return ESP_OK;
}

esp_err_t spi_device_polling_transmit(spi_device_handle_t dev, spi_transaction_t *tx) {
  CHECK(dev != NULL && tx != NULL && tx->length % 8u == 0u);
  ++spi_calls;
  now_us += 100;
  if (spi_calls == fail_at) return ESP_FAIL;

  const uint8_t *data = (const uint8_t *)tx->tx_buffer;
  const size_t len = tx->length / 8u;
  if (dc_level == 0) {
    CHECK(len == 1u);
    current_cmd = data[0];
    ram_cursor = 0u;
    CHECK(current_cmd != 0xA0u && current_cmd != 0xA1u &&
          current_cmd != 0x01u && current_cmd != 0x82u);
    if (current_cmd == 0x10u) uploaded_bytes[0] = 0u;
    if (current_cmd == 0x13u) uploaded_bytes[1] = 0u;
    if (current_cmd == 0x04u) {
      busy_until = stuck_power ? (now_us + 60000000) : (now_us + 30000);
    } else if (current_cmd == 0x02u) {
      ++power_offs;
      busy_until = stuck_off ? (now_us + 60000000) : (now_us + 25000);
    } else if (current_cmd == 0x91u) {
      partial_mode = true;
    } else if (current_cmd == 0x92u) {
      partial_mode = false;
    } else if (current_cmd == 0x12u) {
      if (psr_reg == 0x0Fu) {
        ++clean_drives;
        calibration_marker = 0x51u;
        lut_tables_loaded = 0u;
        memcpy(panel_black, active_ram[0], FRAME_BYTES);
        memcpy(panel_red, active_ram[1], FRAME_BYTES);
        busy_until = no_busy_refresh ? 0 : (stuck_refresh ? (now_us + 60000000) : (now_us + 150000));
      } else if (psr_reg == 0x3Fu) {
        CHECK(calibration_marker == 0x51u && partial_mode);
        lut_tables_loaded = 0u;
        ++quiet_bw_drives;
        busy_until = no_busy_refresh ? 0 : (stuck_refresh ? (now_us + 60000000) : (now_us + 150000));
      } else {
        CHECK(psr_reg == 0x2Fu && calibration_marker == 0x51u && partial_mode);
        CHECK(pll_reg == 0x3Au && cdi_reg == 0xF7u);
        CHECK(lut_tables_loaded == 5u && last_pt_scan == 1u);
        lut_tables_loaded = 0u;
        CHECK(uploaded_bytes[0] == FRAME_BYTES && uploaded_bytes[1] == FRAME_BYTES);
        const unsigned idx = bwr_pass_seen++;
        CHECK(idx < 4u);
        memcpy(captured_ram0[idx], active_ram[0], FRAME_BYTES);
        memcpy(captured_ram1[idx], active_ram[1], FRAME_BYTES);
        ++bwr_drives;
        const unsigned frames = lut_total_frames(captured_luts[idx][2]);
        if (frames == QUIET_BWR_CRISP_FRAMES) pass_phases_seen[idx] = QUIET_BWR_PHASE_CRISP_RED;
        else if (captured_luts[idx][4][0] == 0x80u) pass_phases_seen[idx] = QUIET_BWR_PHASE_CLEAR_WHITE;
        else pass_phases_seen[idx] = QUIET_BWR_PHASE_WRITE_BLACK;
        int64_t drive_us = (int64_t)frames * 10000;
        if (idx < 2u && slow_pass[idx]) {
          drive_us = (int64_t)quiet_bwr_pass_gate_ms(pass_phases_seen[idx]) * 1000 + 20000;
        }
        busy_until = no_busy_refresh ? 0 : (stuck_refresh ? (now_us + 60000000) : (now_us + drive_us));
      }
    }
    return ESP_OK;
  }

  CHECK(dc_level == 1);
  if (current_cmd == 0x00u) {
    CHECK(len == 1u);
    psr_reg = data[0];
  } else if (current_cmd == 0x30u) {
    CHECK(len == 1u && data[0] == 0x3Au);
    pll_reg = data[0];
    ++pll_writes;
  } else if (current_cmd == 0x50u) {
    CHECK(len == 1u);
    cdi_reg = data[0];
    ++cdi_writes;
  } else if (current_cmd >= 0x20u && current_cmd <= 0x24u) {
    const unsigned table = current_cmd - 0x20u;
    CHECK(len == (table == 0u ? 44u : 42u));
    if (bwr_pass_seen < 4u) {
      memset(captured_luts[bwr_pass_seen][table], 0, 44u);
      memcpy(captured_luts[bwr_pass_seen][table], data, len);
    }
    ++lut_tables_loaded;
  } else if (current_cmd == 0x90u) {
    CHECK(len == 9u);
    last_win_x = ((unsigned)data[0] << 8) | data[1];
    const unsigned last_x = ((unsigned)data[2] << 8) | data[3];
    last_win_y = ((unsigned)data[4] << 8) | data[5];
    const unsigned last_y = ((unsigned)data[6] << 8) | data[7];
    last_pt_scan = data[8];
    CHECK(last_win_x % 8u == 0u && last_x % 8u == 7u && last_x > last_win_x && last_x < 400u);
    CHECK(last_win_y < last_y && last_y < 300u);
    last_win_w = last_x - last_win_x + 1u;
    last_win_h = last_y - last_win_y + 1u;
  } else if (current_cmd == 0x10u || current_cmd == 0x13u) {
    const unsigned plane = current_cmd == 0x13u ? 1u : 0u;
    if (!partial_mode) {
      CHECK(ram_cursor + len <= FRAME_BYTES);
      memcpy(active_ram[plane] + ram_cursor, data, len);
      ram_cursor += len;
      uploaded_bytes[plane] = ram_cursor;
    }
  }
  return ESP_OK;
}

static void reset_hw(void) {
  now_us = 1000000;
  busy_until = 0;
  dc_level = cs_level = -1;
  current_cmd = psr_reg = pll_reg = cdi_reg = calibration_marker = 0u;
  partial_mode = stuck_power = stuck_refresh = no_busy_refresh = stuck_off = false;
  slow_pass[0] = slow_pass[1] = false;
  spi_calls = fail_at = resets = clean_drives = quiet_bw_drives = bwr_drives = power_offs = 0u;
  pll_writes = cdi_writes = lut_tables_loaded = bwr_pass_seen = 0u;
  last_pt_scan = last_win_x = last_win_y = last_win_w = last_win_h = 0u;
  memset(pass_phases_seen, 0, sizeof(pass_phases_seen));
  memset(captured_luts, 0, sizeof(captured_luts));
  memset(captured_ram0, 0, sizeof(captured_ram0));
  memset(captured_ram1, 0, sizeof(captured_ram1));
  memset(active_ram, 0xFF, sizeof(active_ram));
  uploaded_bytes[0] = uploaded_bytes[1] = 0u;
  s_spi = NULL;
  s_epd_baseline_valid = false;
  CHECK(epd_ssd1683_init() == ESP_OK);
}

static void test_lut_tables(void) {
  static const uint8_t expected_r22[7][6] = {
      {0xa0, 14, 14, 2, 0, 1}, {0x90, 5, 6, 1, 0, 1},
      {0xb0, 1, 4, 0, 0, 8},   {0xbb, 1, 4, 1, 5, 6},
      {0xbb, 1, 4, 1, 5, 6},   {0xc0, 50, 0, 0, 0, 1},
      {0xc0, 36, 0, 0, 0, 1},
  };
  static const uint8_t expected_r24[7] = {0xa0, 0xa0, 0x80, 0x00, 0xaa, 0x80, 0x80};
  uint8_t lut[44];
  CHECK(quiet_bwr_make_lut(5u, QUIET_BWR_PHASE_CRISP_RED, lut) == 0u);
  CHECK(quiet_bwr_make_lut(0u, QUIET_BWR_PHASE_CRISP_RED, NULL) == 0u);
  CHECK(quiet_bwr_make_lut(0u, QUIET_BWR_PHASE_NONE, lut) == 0u);

  for (unsigned t = 0u; t < 5u; ++t) {
    CHECK(quiet_bwr_make_lut(t, QUIET_BWR_PHASE_CRISP_RED, lut) == (t == 0u ? 44u : 42u));
    CHECK(lut_total_frames(lut) == QUIET_BWR_CRISP_FRAMES);
    for (unsigned g = 0u; g < 7u; ++g) {
      const uint8_t expected_code =
          t == 2u ? expected_r22[g][0] : (t == 4u ? expected_r24[g] : 0u);
      CHECK(lut[g * 6u] == expected_code);
      CHECK(memcmp(lut + g * 6u + 1u, expected_r22[g] + 1u, 5u) == 0);
    }
    CHECK(lut[42] == 0u && lut[43] == 0u);
  }
  for (unsigned t = 0u; t < 5u; ++t) {
    CHECK(quiet_bwr_make_lut(t, QUIET_BWR_PHASE_CLEAR_WHITE, lut) == (t == 0u ? 44u : 42u));
    CHECK(lut[0] == (t == 4u ? 0x80u : 0u) && lut[1] == 178u && lut[3] == 1u && lut[5] == 1u);
    CHECK(lut_total_frames(lut) == QUIET_BWR_CLEAR_FRAMES);
    CHECK(quiet_bwr_make_lut(t, QUIET_BWR_PHASE_WRITE_BLACK, lut) == (t == 0u ? 44u : 42u));
    CHECK(lut[0] == (t == 4u ? 0x40u : 0u) && lut[1] == 150u && lut[3] == 1u && lut[5] == 1u);
    CHECK(lut_total_frames(lut) == QUIET_BWR_BLACK_FRAMES);
  }
}

static uint8_t selector_at(unsigned pass_idx, unsigned x, unsigned y) {
  const size_t idx = (size_t)y * 50u + x / 8u;
  const uint8_t mask = (uint8_t)(0x80u >> (x % 8u));
  return lut_selector_for_f7((captured_ram1[pass_idx][idx] & mask) != 0u,
                             (captured_ram0[pass_idx][idx] & mask) != 0u);
}

static void test_driver_routing_and_faults(void) {
  uint8_t old_b[FRAME_BYTES], old_r[FRAME_BYTES], new_b[FRAME_BYTES], new_r[FRAME_BYTES];
  epd_canvas_t c = {.black = new_b, .red = new_r};
  epd_quiet_metrics_t m;
  unsigned out_y = 0u, out_h = 0u;
  uint32_t full_ms = 0u;

  /* Case 1: Single-pass CRISP_860_A with unchanged static red, unchanged white glyph hole (<=3px),
   * unchanged distant white (>3px), and newly painted red. */
  reset_hw();
  clear_planes(old_b, old_r);
  /* Static red anchor at (24, 24) and unchanged white hole at (164, 140) surrounded by red later. */
  set_px(old_b, old_r, 24u, 24u, EPD_COLOR_RED);
  clear_planes(new_b, new_r);
  memcpy(new_b, old_b, FRAME_BYTES);
  memcpy(new_r, old_r, FRAME_BYTES);
  /* Baseline refresh establishes canonical panel session. */
  {
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
  }
  for (unsigned y = 136u; y <= 144u; ++y) {
    for (unsigned x = 160u; x <= 168u; ++x) {
      if (x == 164u && y == 140u) continue; /* White glyph hole inside new red block. */
      set_px(new_b, new_r, x, y, EPD_COLOR_RED);
    }
  }
  CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) == ESP_OK);
  CHECK(s_epd_baseline_valid && resets == 1u && bwr_drives == 1u && power_offs == 2u);
  CHECK(pass_phases_seen[0] == QUIET_BWR_PHASE_CRISP_RED);
  CHECK(last_pt_scan == 1u && last_win_x == 160u && last_win_w == 16u &&
        last_win_y == 136u && last_win_h == 9u);
  CHECK(m.x == 160u && m.width == 16u && out_y == 136u && out_h == 9u);
  CHECK(selector_at(0u, 160u, 136u) == 0x22u); /* New red -> CRISP_860_A */
  CHECK(selector_at(0u, 164u, 140u) == 0x24u); /* Unchanged white glyph hole -> white_a */
  CHECK(selector_at(0u, 164u, 132u) == 0x23u); /* 4 px above new red -> HOLD */
  CHECK(selector_at(0u, 24u, 24u) == 0x23u);   /* Distant static red -> HOLD */
  CHECK(!memcmp(active_ram[0], new_b, FRAME_BYTES) && !memcmp(active_ram[1], new_r, FRAME_BYTES));

  /* Case 2: Mixed transition (new red + red->black + white->black + black->white + red->white). */
  reset_hw();
  clear_planes(old_b, old_r);
  set_px(old_b, old_r, 40u, 60u, EPD_COLOR_RED);   /* -> WHITE */
  set_px(old_b, old_r, 41u, 60u, EPD_COLOR_RED);   /* -> BLACK (must pre-clear in pass 0!) */
  set_px(old_b, old_r, 42u, 60u, EPD_COLOR_BLACK); /* -> WHITE */
  set_px(old_b, old_r, 43u, 60u, EPD_COLOR_RED);   /* -> RED (static hold) */
  {
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
  }
  memcpy(new_b, old_b, FRAME_BYTES);
  memcpy(new_r, old_r, FRAME_BYTES);
  set_px(new_b, new_r, 40u, 60u, EPD_COLOR_WHITE);
  set_px(new_b, new_r, 41u, 60u, EPD_COLOR_BLACK);
  set_px(new_b, new_r, 42u, 60u, EPD_COLOR_WHITE);
  set_px(new_b, new_r, 44u, 60u, EPD_COLOR_RED);   /* -> NEW RED */
  set_px(new_b, new_r, 80u, 70u, EPD_COLOR_BLACK); /* White -> BLACK */
  bwr_pass_seen = 0u;
  CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) == ESP_OK);
  CHECK(bwr_pass_seen == 2u);
  CHECK(pass_phases_seen[0] == QUIET_BWR_PHASE_CRISP_RED &&
        pass_phases_seen[1] == QUIET_BWR_PHASE_WRITE_BLACK);
  /* Pass 0: 44->RED(0x22), 40->WHITE(0x24), 41->pre-clear(0x24), 42->WHITE(0x24), 43->HOLD(0x23), 80->HOLD(0x23) */
  CHECK(selector_at(0u, 44u, 60u) == 0x22u && selector_at(0u, 40u, 60u) == 0x24u &&
        selector_at(0u, 41u, 60u) == 0x24u && selector_at(0u, 42u, 60u) == 0x24u &&
        selector_at(0u, 43u, 60u) == 0x23u && selector_at(0u, 80u, 70u) == 0x23u);
  /* Pass 1: ONLY 41 and 80 (target black) select 0x24 WRITE_BLACK; everything else is 0x23 HOLD. */
  CHECK(selector_at(1u, 44u, 60u) == 0x23u && selector_at(1u, 40u, 60u) == 0x23u &&
        selector_at(1u, 41u, 60u) == 0x24u && selector_at(1u, 42u, 60u) == 0x23u &&
        selector_at(1u, 43u, 60u) == 0x23u && selector_at(1u, 80u, 70u) == 0x24u);

  /* Case 3: Static red + BW change (must NOT run CRISP_860_A). */
  reset_hw();
  clear_planes(old_b, old_r);
  set_px(old_b, old_r, 100u, 100u, EPD_COLOR_RED);
  set_px(old_b, old_r, 399u, 299u, EPD_COLOR_BLACK);
  {
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
  }
  memcpy(new_b, old_b, FRAME_BYTES);
  memcpy(new_r, old_r, FRAME_BYTES);
  set_px(new_b, new_r, 399u, 299u, EPD_COLOR_WHITE); /* Single pixel at bottom-right corner! */
  CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) == ESP_OK);
  CHECK(bwr_pass_seen == 1u && pass_phases_seen[0] == QUIET_BWR_PHASE_CLEAR_WHITE);
  CHECK(last_win_x == 384u && last_win_w == 16u && last_win_y == 298u && last_win_h == 2u);
  CHECK(selector_at(0u, 100u, 100u) == 0x23u && selector_at(0u, 399u, 299u) == 0x24u);

  /* Case 4: Every SPI transaction failure invalidates baseline and stops immediately. */
  unsigned total_calls = 0u;
  {
    const unsigned baseline_calls = spi_calls;
    reset_hw();
    clear_planes(old_b, old_r);
    set_px(old_b, old_r, 24u, 24u, EPD_COLOR_BLACK);
    {
      epd_canvas_t base_c = {.black = old_b, .red = old_r};
      CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
    }
    const unsigned base_cnt = spi_calls;
    memcpy(new_b, old_b, FRAME_BYTES);
    memcpy(new_r, old_r, FRAME_BYTES);
    set_px(new_b, new_r, 24u, 24u, EPD_COLOR_RED);
    set_px(new_b, new_r, 25u, 24u, EPD_COLOR_BLACK);
    CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) == ESP_OK);
    total_calls = spi_calls - base_cnt;
    (void)baseline_calls;
  }
  for (unsigned fault = 1u; fault <= total_calls; ++fault) {
    reset_hw();
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
    fail_at = spi_calls + fault;
    CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) == ESP_FAIL);
    CHECK(!s_epd_baseline_valid && cs_level == 1 && dc_level == 0);
    const unsigned stopped = spi_calls;
    CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) ==
          ESP_ERR_INVALID_STATE);
    CHECK(spi_calls == stopped);
  }

  /* Slow pass-0 gate stops before pass 1; stuck BUSY & missing BUSY fail safely. */
  reset_hw();
  {
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
  }
  slow_pass[0] = true;
  CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) ==
        ESP_ERR_INVALID_RESPONSE);
  CHECK(!s_epd_baseline_valid && bwr_pass_seen == 1u);

  reset_hw();
  {
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
  }
  stuck_refresh = true;
  CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) == ESP_ERR_TIMEOUT);
  CHECK(!s_epd_baseline_valid);

  reset_hw();
  {
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
  }
  no_busy_refresh = true;
  CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) ==
        ESP_ERR_INVALID_RESPONSE);
  CHECK(!s_epd_baseline_valid);

  /* Invalid arguments never touch SPI. */
  reset_hw();
  {
    epd_canvas_t base_c = {.black = old_b, .red = old_r};
    CHECK(epd_ssd1683_refresh(&base_c, &full_ms) == ESP_OK);
  }
  const unsigned before_bad = spi_calls;
  CHECK(epd_quiet_bwr_refresh(NULL, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) ==
        ESP_ERR_INVALID_ARG);
  CHECK(epd_quiet_bwr_refresh(&c, new_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) ==
        ESP_ERR_INVALID_ARG);
  new_b[0] = 0u;
  new_r[0] = 0u;
  CHECK(epd_quiet_bwr_refresh(&c, old_b, old_r, FRAME_BYTES, &out_y, &out_h, &m) ==
        ESP_ERR_INVALID_ARG);
  CHECK(spi_calls == before_bad);
}

static codepulse_ui_model_t sample_model(void) {
  codepulse_ui_model_t m = {
      .display = {.valid = true, .hud = true, .remaining = true,
                  .show_quota = true, .show_environment = true, .agent_mask = 7},
      .thread_count = 2,
      .thread_total = 2,
      .environment_valid = true,
      .temperature_c = 26.5f,
      .humidity_rh = 48.0f,
      .battery_valid = true,
      .battery_percent = 80u,
      .wifi_connected = true,
      .agent_count = 2,
      .agents = {{CODEPULSE_UI_AGENT_CLAUDE, CODEPULSE_UI_AGENT_RUNNING, 20, 40},
                 {CODEPULSE_UI_AGENT_CODEX, CODEPULSE_UI_AGENT_DONE, -1, 50}},
  };
  strcpy(m.threads[0].id, "t-0");
  strcpy(m.threads[0].title, "Build firmware");
  strcpy(m.threads[0].detail, "compiling");
  m.threads[0].type = CODEPULSE_UI_AGENT_CLAUDE;
  m.threads[0].state = CODEPULSE_UI_AGENT_RUNNING;
  m.threads[0].level = CODEPULSE_LEVEL_ACTIVE;
  strcpy(m.threads[1].id, "t-1");
  strcpy(m.threads[1].title, "Review PR");
  strcpy(m.threads[1].detail, "ready");
  m.threads[1].type = CODEPULSE_UI_AGENT_CODEX;
  m.threads[1].state = CODEPULSE_UI_AGENT_DONE;
  m.threads[1].level = CODEPULSE_LEVEL_NOTICE;
  return m;
}

static void test_dashboard_integration(void) {
  reset_hw();
  uint8_t b[FRAME_BYTES], r[FRAME_BYTES];
  epd_canvas_t c = {.black = b, .red = r};
  quiet_dashboard_t state = {0};
  quiet_dashboard_result_t res;
  codepulse_ui_model_t m = sample_model();

  /* Boot: clean baseline with no red. */
  CHECK(quiet_dashboard_update(&state, &c, &m, 0, &res) == ESP_OK);
  CHECK(res.full && !res.red_full && !res.red_crisp && res.changed);
  CHECK(clean_drives == 1u && bwr_drives == 0u && quiet_bw_drives == 0u);

  /* Task 0 needs permission -> red badge + red meta -> dynamic BWR Crisp860A! */
  m.threads[0].state = CODEPULSE_UI_AGENT_WAITING;
  m.threads[0].level = CODEPULSE_LEVEL_ACTION;
  strcpy(m.threads[0].detail, "approve push");
  bwr_pass_seen = 0u;
  CHECK(quiet_dashboard_update(&state, &c, &m, 1000, &res) == ESP_OK);
  CHECK(!res.full && !res.red_full && res.red_crisp && res.changed);
  CHECK(clean_drives == 1u && bwr_drives >= 1u && state.previous_has_red);
  CHECK(pass_phases_seen[0] == QUIET_BWR_PHASE_CRISP_RED);

  /* Unchanged frame triggers zero drives. */
  const unsigned prev_bwr = bwr_drives;
  CHECK(quiet_dashboard_update(&state, &c, &m, 2000, &res) == ESP_OK && !res.changed);
  CHECK(bwr_drives == prev_bwr);

  /* Task 0 stays red while Task 1 changes in BW -> BWR without CRISP_RED! */
  bwr_pass_seen = 0u;
  strcpy(m.threads[1].title, "Review PR updated");
  CHECK(quiet_dashboard_update(&state, &c, &m, 3000, &res) == ESP_OK);
  CHECK(!res.full && !res.red_full && res.red_crisp && res.changed);
  for (unsigned p = 0u; p < bwr_pass_seen; ++p) {
    CHECK(pass_phases_seen[p] != QUIET_BWR_PHASE_CRISP_RED);
  }

  /* Leave red back to BW -> CLEAR_WHITE/WRITE_BLACK erase, zero full refresh. */
  m.threads[0].state = CODEPULSE_UI_AGENT_RUNNING;
  m.threads[0].level = CODEPULSE_LEVEL_ACTIVE;
  strcpy(m.threads[0].detail, "resumed");
  bwr_pass_seen = 0u;
  CHECK(quiet_dashboard_update(&state, &c, &m, 4000, &res) == ESP_OK);
  CHECK(!res.full && !res.red_full && res.red_crisp && !state.previous_has_red);

  /* Re-enter red immediately without cooldown folding! */
  m.threads[0].state = CODEPULSE_UI_AGENT_ERROR;
  m.threads[0].level = CODEPULSE_LEVEL_FAULT;
  strcpy(m.threads[0].detail, "build failed");
  bwr_pass_seen = 0u;
  CHECK(quiet_dashboard_update(&state, &c, &m, 4001, &res) == ESP_OK);
  CHECK(!res.full && res.red_crisp && state.previous_has_red);
  CHECK(pass_phases_seen[0] == QUIET_BWR_PHASE_CRISP_RED);

  /* Subsequent pure BW change runs normal PAIR150 epd_quiet_refresh. */
  m.threads[0].state = CODEPULSE_UI_AGENT_DONE;
  m.threads[0].level = CODEPULSE_LEVEL_NOTICE;
  bwr_pass_seen = 0u;
  CHECK(quiet_dashboard_update(&state, &c, &m, 5000, &res) == ESP_OK);
  CHECK(!state.previous_has_red && res.red_crisp);
  const unsigned bw_before = quiet_bw_drives;
  m.agents[0].weekly_percent = 30;
  CHECK(quiet_dashboard_update(&state, &c, &m, 6000, &res) == ESP_OK);
  CHECK(!res.full && !res.red_crisp && res.changed && quiet_bw_drives == bw_before + 1u);

  /* Driver failure latches dashboard fault without corrupting previous planes. */
  uint8_t saved_prev[FRAME_BYTES], saved_prev_red[FRAME_BYTES];
  memcpy(saved_prev, state.previous, FRAME_BYTES);
  memcpy(saved_prev_red, state.previous_red, FRAME_BYTES);
  bwr_pass_seen = 0u;
  stuck_refresh = true;
  m.threads[0].state = CODEPULSE_UI_AGENT_WAITING;
  m.threads[0].level = CODEPULSE_LEVEL_ACTION;
  CHECK(quiet_dashboard_update(&state, &c, &m, 7000, &res) == ESP_ERR_TIMEOUT);
  CHECK(state.faulted);
  CHECK(!memcmp(state.previous, saved_prev, FRAME_BYTES) &&
        !memcmp(state.previous_red, saved_prev_red, FRAME_BYTES));
  CHECK(quiet_dashboard_update(&state, &c, &m, 8000, &res) == ESP_ERR_INVALID_STATE);
  (void)px_ink;
}

int main(void) {
  CHECK(display_text_init());
  test_lut_tables();
  test_driver_routing_and_faults();
  test_dashboard_integration();
  puts("PASS: ProductionRed68 CRISP_860_A + .43 LUTs, PT_SCAN=1, 3px glyph holes, mixed 2-pass routing, static-red HOLD, SPI fault latching, and quiet_dashboard transitions");
  return 0;
}
