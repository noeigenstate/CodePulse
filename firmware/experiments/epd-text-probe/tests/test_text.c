#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "text_sequence.h"

static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t previous_frame[EPD_CANVAS_BUFFER_SIZE], expected_old[EPD_CANVAS_BUFFER_SIZE];
static uint8_t patterns[2][EPD_CANVAS_BUFFER_SIZE];
static unsigned attempts, fail_at;

esp_err_t epd_quiet_probe_refresh(const epd_canvas_t *canvas,
    const uint8_t *old, size_t size, epd_quiet_phase_t phase,
    epd_quiet_metrics_t *metrics) {
  assert(size == EPD_CANVAS_BUFFER_SIZE && metrics);
  const bool baseline = attempts == 0;
  assert(phase == (baseline ? QUIET_OTP_BASELINE : QUIET_LONG_PAIR));
  assert(!memcmp(canvas->black, patterns[attempts & 1u], sizeof(black)));
  for (size_t i = 0; i < sizeof(red); ++i) assert(canvas->red[i] == 0xFF);
  if (baseline) assert(old == NULL);
  else assert(old == previous_frame && !memcmp(old, expected_old, sizeof(expected_old)));
  ++attempts;
  if (attempts == fail_at) return ESP_FAIL;
  memcpy(expected_old, canvas->black, sizeof(expected_old));
  return ESP_OK;
}

static void save_pattern(unsigned active) {
  char name[32];
  (void)snprintf(name, sizeof(name), "text-probe-%u.pgm", active);
  FILE *f = NULL;
  assert(fopen_s(&f, name, "wb") == 0 && f);
  fprintf(f, "P5\n400 300\n255\n");
  for (int y = 0; y < 300; ++y)
    for (int x = 0; x < 400; ++x)
      fputc(patterns[active][y * 50 + x / 8] & (0x80u >> (x % 8)) ? 255 : 0, f);
  assert(fclose(f) == 0);
}

int main(void) {
  epd_canvas_t canvas = {.black = black, .red = red};
  for (unsigned active = 0; active < 2; ++active) {
    text_probe_pattern(&canvas, active != 0);
    memcpy(patterns[active], black, sizeof(black));
    for (size_t i = 0; i < sizeof(red); ++i) assert(red[i] == 0xFF);
    save_pattern(active);
  }
  unsigned changed = 0;
  for (int y = 0; y < 300; ++y) {
    for (int x = 0; x < 400; ++x) {
      const unsigned mask = 0x80u >> (x % 8);
      const bool diff = ((patterns[0][y * 50 + x / 8] ^ patterns[1][y * 50 + x / 8]) & mask) != 0;
      if (diff) { ++changed; assert(y >= 184 && y < 224 && x >= 120); }
    }
  }
  assert(changed > 100);
  /* Successful OLD/NEW chain and failure at each real state transition. */
  for (unsigned failure = 0; failure <= TEXT_PROBE_STEP_COUNT; ++failure) {
    text_probe_state_t state = {0};
    epd_quiet_metrics_t m = {0};
    attempts = 0; fail_at = failure;
    memset(previous_frame, 0xA5, sizeof(previous_frame));
    for (unsigned step = 0; step < TEXT_PROBE_STEP_COUNT; ++step) {
      uint8_t saved_old[EPD_CANVAS_BUFFER_SIZE];
      memcpy(saved_old, previous_frame, sizeof(saved_old));
      const esp_err_t result = text_probe_render_step(&state, &canvas,
          previous_frame, sizeof(previous_frame), &m);
      if (failure == step + 1u) {
        assert(result == ESP_FAIL && state.stopped && state.next_step == step);
        assert(!memcmp(saved_old, previous_frame, sizeof(saved_old)));
        break;
      }
      assert(result == ESP_OK && state.next_step == step + 1u);
      assert(!memcmp(previous_frame, expected_old, sizeof(previous_frame)));
    }
    assert(state.stopped);
    const unsigned count = attempts;
    assert(text_probe_render_step(&state, &canvas, previous_frame,
        sizeof(previous_frame), &m) == ESP_ERR_INVALID_STATE);
    assert(attempts == count);
  }
  text_probe_state_t fresh = {0};
  epd_quiet_metrics_t m = {0};
  const unsigned count = attempts;
  assert(text_probe_render_step(NULL, &canvas, previous_frame, sizeof(previous_frame), &m) == ESP_ERR_INVALID_ARG);
  assert(text_probe_render_step(&fresh, &canvas, NULL, 0, &m) == ESP_ERR_INVALID_ARG);
  assert(text_probe_render_step(&fresh, &canvas, previous_frame, 2000, &m) == ESP_ERR_INVALID_ARG);
  assert(attempts == count && fresh.next_step == 0);
  puts("PASS: true renderer confines text to B window; exact OLD/NEW chain; four-update cap; failure preserves OLD and blocks retry");
}
