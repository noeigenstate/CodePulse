/* Host-only deterministic replay of the production renderer, pacing and refresh
 * selector. The two panel entry points below are transport spies, not optics. */
#include "display_sync_policy.h"
#include "quiet_dashboard.h"
#include "../../tests/test_check.h"
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FRAME EPD_CANVAS_BUFFER_SIZE
#define FULL_CLOCK_MS 16000u
#define QUIET_CLOCK_MS 3000u
static uint8_t black[FRAME], red[FRAME], panel_black[FRAME], panel_red[FRAME];
static uint8_t target_black[FRAME], target_red[FRAME];
static unsigned full_calls, quiet_calls;
static bool panel_valid;
static FILE *csv, *summary;
static unsigned issue_count;

/* Durations advance a synthetic monotonic clock only. They are not measurements. */
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *c, uint32_t *duration) {
  CHECK(c && duration);
  for (size_t i = 0; i < FRAME; i++) CHECK((c->black[i] | c->red[i]) == 255);
  memcpy(panel_black, c->black, FRAME); memcpy(panel_red, c->red, FRAME);
  panel_valid = true; full_calls++; *duration = FULL_CLOCK_MS;
  return ESP_OK;
}
esp_err_t epd_quiet_refresh(const epd_canvas_t *c, const uint8_t *old,
    size_t size, unsigned y, unsigned height, epd_quiet_metrics_t *timing) {
  CHECK(panel_valid && size == FRAME && !memcmp(old, panel_black, FRAME));
  CHECK(height && y < 300 && height <= 300 - y);
  for (size_t i = 0; i < FRAME; i++) CHECK(c->red[i] == 255 && panel_red[i] == 255);
  CHECK(!memcmp(old, c->black, y * 50u));
  CHECK(!memcmp(old + (y + height) * 50u, c->black + (y + height) * 50u,
                FRAME - (y + height) * 50u));
  memcpy(panel_black, c->black, FRAME); quiet_calls++;
  *timing = (epd_quiet_metrics_t){.total_ms = QUIET_CLOCK_MS,
      .refresh_ms = QUIET_CLOCK_MS, .width = 400, .busy_seen = true};
  return ESP_OK;
}

static unsigned bits(uint8_t v) {
  unsigned n = 0;
  for (; v; v &= (uint8_t)(v - 1)) n++;
  return n;
}
static unsigned pigment(const uint8_t *p) {
  unsigned n = 0;
  for (size_t i = 0; i < FRAME; i++) n += bits((uint8_t)~p[i]);
  return n;
}
static unsigned difference(const uint8_t *a, const uint8_t *b) {
  unsigned n = 0;
  for (size_t i = 0; i < FRAME; i++) n += bits(a[i] ^ b[i]);
  return n;
}
static void save_ppm(const char *scenario, unsigned inverted, unsigned step) {
  char name[128];
  snprintf(name, sizeof(name), "%s-inv%u-step%u.ppm", scenario, inverted, step);
  FILE *f = fopen(name, "wb"); CHECK(f);
  fprintf(f, "P6\n400 300\n255\n");
  for (unsigned y = 0; y < 300; y++) for (unsigned x = 0; x < 400; x++) {
    const unsigned i = y * 50 + x / 8; const uint8_t mask = (uint8_t)(0x80u >> (x % 8));
    const bool r = !(panel_red[i] & mask), b = !(panel_black[i] & mask);
    const uint8_t rgb[3] = {b ? 0 : r ? 190 : 255, b || r ? 0 : 255, b || r ? 0 : 255};
    CHECK(fwrite(rgb, 1, 3, f) == 3);
  }
  CHECK(!fclose(f));
}

typedef enum {
  BW_WORK, STATIC_RED_WORK, RED_WORK_CHANGE, STATIC_RED_CARD, RED_CARD_CHANGE,
  HELD_RED_CARD, CALENDAR_BW, LIFE_BW, RED_REENTRY, RED_IN_WINDOW, SAME_PIXELS_NEW_ID, SCENARIO_COUNT
} scenario_t;
static const char *const names[] = {
  "bw-work", "static-red-work", "red-work-change", "static-red-card",
  "red-card-change", "held-red-card", "calendar-bw", "life-bw", "red-reentry",
  "red-in-dirty-window", "same-pixels-new-id"
};
typedef struct { codepulse_ui_model_t model; codepulse_ambient_t card; } fixture_t;
static fixture_t fixture;

static void card_id(fixture_t *f, unsigned value) {
  snprintf(f->card.id, sizeof(f->card.id), "red-replay-%u", value);
  strcpy(f->model.ambient_id, f->card.id);
}
static void init_fixture(fixture_t *f, scenario_t scenario, bool inverted) {
  memset(f, 0, sizeof(*f));
  f->model = (codepulse_ui_model_t){
      .display = {.valid = true, .hud = true, .show_quota = true,
          .show_environment = true, .remaining = true, .agent_mask = 7, .inverted = inverted},
      .thread_count = 2, .thread_total = 2, .wifi_connected = true,
      .environment_valid = true, .temperature_c = 25, .humidity_rh = 50,
      .battery_valid = true, .battery_percent = 72, .agent_count = 3,
      .agents = {{CODEPULSE_UI_AGENT_CLAUDE, CODEPULSE_UI_AGENT_RUNNING, 30, 20},
          {CODEPULSE_UI_AGENT_CODEX, CODEPULSE_UI_AGENT_RUNNING, -1, 40},
          {CODEPULSE_UI_AGENT_GROK, CODEPULSE_UI_AGENT_IDLE, -1, 50}}};
  for (unsigned i = 0; i < 2; i++) {
    codepulse_ui_thread_t *t = &f->model.threads[i];
    snprintf(t->id, sizeof(t->id), "replay-%u", i);
    snprintf(t->title, sizeof(t->title), "Replay task %u A", i);
    strcpy(t->detail, "Test fixture"); t->type = CODEPULSE_UI_AGENT_CODEX;
    t->state = CODEPULSE_UI_AGENT_RUNNING;
  }
  if (scenario == STATIC_RED_WORK || scenario == RED_WORK_CHANGE || scenario == RED_REENTRY)
    f->model.threads[0].state = CODEPULSE_UI_AGENT_WAITING;
  if ((scenario >= STATIC_RED_CARD && scenario <= LIFE_BW) ||
      scenario == RED_IN_WINDOW || scenario == SAME_PIXELS_NEW_ID) {
    f->model.ambient = &f->card; card_id(f, 0);
    strcpy(f->card.source, "Replay fixture"); strcpy(f->card.text, "Fixed red / BW update");
    f->card.has_image = true; f->card.has_red = true;
    f->card.red_x = 128; f->card.red_y = 40; f->card.red_w = 16; f->card.red_h = 2;
    f->card.red[0] = 0xc0; f->card.red[1] = 0x01; f->card.red[2] = 0x80;
    f->card.red[3] = 0x01;
    if (scenario == CALENDAR_BW) {
      f->card.has_image = f->card.has_red = false;
      f->card.layout = CODEPULSE_AMBIENT_LAYOUT_CALENDAR;
      f->card.calendar = (codepulse_calendar_t){.year = 2026, .month = 11, .first = 6,
          .days = 30, .today = 5, .week = 45, .lunar = "Test calendar"};
    } else if (scenario == LIFE_BW) {
      f->card.has_image = f->card.has_red = false;
      f->card.layout = CODEPULSE_AMBIENT_LAYOUT_LIFE;
      f->card.life = (codepulse_life_t){.version = 1, .kind = LIFE_STOCK,
          .data.stock = {.direction = LIFE_UP, .state = 1, .name = "苹果", .symbol = "AAPL.US",
              .hero = "341.24", .percent = "0.98%", .change = "+3.39", .low = "339.61",
              .high = "343.78", .open = "342.67", .previous = "344.63", .source = "测试"}};
    }
  }
}
static void mutate(fixture_t *f, scenario_t scenario, unsigned step) {
  const unsigned phase = step % 2;
  switch (scenario) {
  case BW_WORK: case STATIC_RED_WORK:
    snprintf(f->model.threads[1].title, sizeof(f->model.threads[1].title),
             "Replay task 1 %c", phase ? 'B' : 'A'); break;
  case RED_WORK_CHANGE:
    f->model.threads[0].state = phase ? CODEPULSE_UI_AGENT_ERROR : CODEPULSE_UI_AGENT_WAITING; break;
  case STATIC_RED_CARD: case HELD_RED_CARD:
    f->card.image[80 * 48 + 4] = phase ? 0x80 : 0;
    if (scenario != HELD_RED_CARD) card_id(f, step);
    break;
  case RED_IN_WINDOW:
    /* Two separated BW changes enclose the unchanged red rectangle. */
    f->card.image[30 * 48 + 14] = phase ? 0x80 : 0;
    f->card.image[50 * 48 + 18] = phase ? 0x01 : 0;
    card_id(f, step); break;
  case SAME_PIXELS_NEW_ID:
    card_id(f, step); break;
  case RED_CARD_CHANGE:
    f->card.red[0] = phase ? 0xa0 : 0xc0; card_id(f, step); break;
  case CALENDAR_BW:
    f->model.battery_percent = phase ? 20 : 72; card_id(f, step); break;
  case LIFE_BW:
    strcpy(f->card.life.data.stock.source, phase ? "TEST B" : "测试"); card_id(f, step); break;
  case RED_REENTRY:
    f->model.threads[0].state = phase ? CODEPULSE_UI_AGENT_RUNNING : CODEPULSE_UI_AGENT_WAITING; break;
  default: CHECK(false);
  }
}

typedef struct {
  unsigned updates, full, quiet, unchanged, suppressed, static_red_full, red_changed_full, folded;
} stats_t;
static quiet_dashboard_t state;
static display_sync_policy_t policy;
static int64_t now_ms;
static void update(const char *name, scenario_t scenario, unsigned round, unsigned inverted,
    unsigned step, bool duplicate, stats_t *stats) {
  const unsigned full_before = full_calls, quiet_before = quiet_calls;
  const bool baseline = !state.initialized;
  const display_sync_reason_t reason = display_sync_evaluate(&policy, now_ms, &fixture.model);
  codepulse_ui_model_t projected;
  display_sync_project(&policy, now_ms, &fixture.model, false, &projected);
  epd_canvas_t target = {target_black, target_red};
  quiet_dashboard_render(&target, &projected);
  const unsigned target_red_pixels = pigment(target_red);
  const unsigned old_red_pixels = baseline ? 0 : pigment(panel_red);
  const unsigned black_diff = baseline ? 0 : difference(panel_black, target_black);
  const unsigned red_diff = baseline ? 0 : difference(panel_red, target_red);
  unsigned first_x = 50, end_x = 0, first_y = 300, end_y = 0, red_in_window = 0;
  if (!baseline) for (unsigned y = 0; y < 300; y++) for (unsigned x = 0; x < 50; x++)
    if (panel_black[y * 50 + x] != target_black[y * 50 + x]) {
      if (x < first_x) first_x = x;
      if (x + 1 > end_x) end_x = x + 1;
      if (y < first_y) first_y = y;
      if (y + 1 > end_y) end_y = y + 1;
    }
  if (end_x) {
    if (end_x - first_x == 1) { if (end_x < 50) end_x++; else first_x--; }
    for (unsigned y = first_y; y < end_y; y++) for (unsigned x = first_x; x < end_x; x++)
      red_in_window += bits((uint8_t)~panel_red[y * 50 + x]);
  } else first_x = first_y = 0;
  quiet_dashboard_result_t result = {0};
  const char *mode = "suppressed";
  if (reason != DISPLAY_SYNC_NONE) {
    epd_canvas_t canvas = {black, red};
    CHECK(quiet_dashboard_update(&state, &canvas, &projected, now_ms, &result) == ESP_OK);
    now_ms += result.timing.total_ms;
    display_sync_record_attempt(&policy, now_ms, &projected, true);
    mode = result.full ? (result.red_full ? "red_full" : "clean_baseline") :
        result.changed ? "quiet" : "unchanged";
    CHECK(!memcmp(state.previous, panel_black, FRAME));
    CHECK(state.previous_has_red == (pigment(panel_red) > 0));
    if (!result.changed) CHECK(full_before == full_calls && quiet_before == quiet_calls);
  } else CHECK(full_before == full_calls && quiet_before == quiet_calls);
  CHECK(full_calls - full_before == (result.full ? 1u : 0u));
  CHECK(quiet_calls - quiet_before == (result.changed && !result.full ? 1u : 0u));
  const bool folded = reason != DISPLAY_SYNC_NONE && target_red_pixels && !pigment(panel_red);
  const bool static_red_full = !baseline && !duplicate && result.full &&
      old_red_pixels && red_diff == 0 && black_diff > 0;
  const bool red_changed_full = !baseline && result.full && red_diff > 0;
  if (static_red_full) issue_count++;
  if (!baseline && !duplicate) {
    stats->updates++; stats->full += result.full; stats->quiet += result.changed && !result.full;
    stats->suppressed += reason == DISPLAY_SYNC_NONE;
    stats->unchanged += reason != DISPLAY_SYNC_NONE && !result.changed;
    stats->static_red_full += static_red_full; stats->red_changed_full += red_changed_full;
    stats->folded += folded;
  }
  if (duplicate) CHECK(full_before == full_calls && quiet_before == quiet_calls);
  if (!baseline && !duplicate && scenario == BW_WORK) {
    CHECK(!target_red_pixels && black_diff && result.changed && !result.full);
  }
  if (!baseline && !duplicate && scenario == HELD_RED_CARD) CHECK(reason == DISPLAY_SYNC_NONE);
  if (!baseline && !duplicate && (scenario == STATIC_RED_WORK || scenario == STATIC_RED_CARD ||
      scenario == CALENDAR_BW || scenario == LIFE_BW || scenario == RED_IN_WINDOW)) {
    CHECK(target_red_pixels && old_red_pixels && black_diff && !red_diff);
    CHECK(reason != DISPLAY_SYNC_NONE && result.changed);
  }
  if (!baseline && !duplicate && (scenario == RED_WORK_CHANGE || scenario == RED_CARD_CHANGE))
    CHECK(red_diff > 0 && result.changed);
  if (!baseline && !duplicate && scenario == RED_IN_WINDOW) CHECK(red_in_window > 0);
  if (!baseline && !duplicate && scenario == SAME_PIXELS_NEW_ID) {
    CHECK(reason == DISPLAY_SYNC_LAYOUT && !result.changed && !black_diff && !red_diff);
  }
  if (!baseline && !duplicate && scenario == RED_REENTRY && step % 4 == 0)
    CHECK(result.red_full && pigment(panel_red) && !folded);
  if (!baseline && !duplicate && scenario == RED_REENTRY && step <= 2) {
    if (step == 1) CHECK(result.red_full && !pigment(panel_red));
    else CHECK(!result.full && folded);
  }
  fprintf(csv, "%s,%u,%u,%u,%u,%" PRId64 ",%s,%s,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u\n",
      name, round, inverted, step, duplicate, now_ms, display_sync_reason_name(reason), mode,
      black_diff, red_diff, first_x * 8u, first_y, (end_x - first_x) * 8u,
      end_y - first_y, red_in_window, old_red_pixels, target_red_pixels, pigment(panel_red),
      static_red_full, folded, baseline);
  if (!round && !duplicate && step <= 1) save_ppm(name, inverted, step);
}
static unsigned argument(const char *text) {
  char *end = NULL; unsigned long value = strtoul(text, &end, 10);
  CHECK(end && !*end && value >= 1 && value <= 10000);
  return (unsigned)value;
}
int main(int argc, char **argv) {
  const unsigned iterations = argc > 1 ? argument(argv[1]) : 40;
  const unsigned rounds = argc > 2 ? argument(argv[2]) : 3;
  const bool require_fix = argc > 3 && !strcmp(argv[3], "--require-no-static-red-full");
  csv = fopen("steps.csv", "wb"); summary = fopen("summary.csv", "wb"); CHECK(csv && summary);
  fprintf(csv, "scenario,round,inverted,step,duplicate,logical_completion_ms,reason,mode,bw_diff_pixels,red_diff_pixels,bw_x,bw_y,bw_width,bw_height,red_in_bw_window,previous_red_pixels,target_red_pixels,displayed_red_pixels,static_red_full,red_folded,baseline\n");
  fprintf(summary, "scenario,updates,full,quiet,unchanged,suppressed,static_red_full,red_changed_full,folded\n");
  puts("HOST REPLAY: production renderer + scheduler + selector; mocked transport; synthetic clock; no optical claims.");
  for (scenario_t scenario = BW_WORK; scenario < SCENARIO_COUNT; scenario++) {
    stats_t stats = {0};
    for (unsigned round = 0; round < rounds; round++) for (unsigned inverted = 0; inverted < 2; inverted++) {
      state = (quiet_dashboard_t){0}; policy = (display_sync_policy_t){0}; now_ms = 0;
      full_calls = quiet_calls = 0; panel_valid = false;
      memset(panel_black, 255, FRAME); memset(panel_red, 255, FRAME);
      init_fixture(&fixture, scenario, inverted != 0);
      update(names[scenario], scenario, round, inverted, 0, false, &stats);
      for (unsigned step = 1; step <= iterations; step++) {
        /* Each new event occurs after the previous simulated drive completed. */
        now_ms += 1;
        /* Explicit new event exactly at cooldown completion, never a timer drive. */
        if (scenario == RED_REENTRY && step % 4 == 0)
          now_ms = state.last_full_ms + CODEPULSE_RED_FULL_COOLDOWN_MS;
        mutate(&fixture, scenario, step);
        update(names[scenario], scenario, round, inverted, step, false, &stats);
        now_ms += 1; update(names[scenario], scenario, round, inverted, step, true, &stats);
      }
    }
    fprintf(summary, "%s,%u,%u,%u,%u,%u,%u,%u,%u\n", names[scenario], stats.updates,
        stats.full, stats.quiet, stats.unchanged, stats.suppressed, stats.static_red_full,
        stats.red_changed_full, stats.folded);
    printf("%-18s updates=%u full=%u quiet=%u suppressed=%u unchanged=%u static_red_full=%u folded=%u\n",
        names[scenario], stats.updates, stats.full, stats.quiet, stats.suppressed,
        stats.unchanged, stats.static_red_full, stats.folded);
  }
  CHECK(!fclose(csv) && !fclose(summary));
  printf("REPLAY COMPLETE: %u full refreshes with byte-identical red and changed BW.\n", issue_count);
  if (require_fix && issue_count) {
    fputs("ACCEPTANCE FAILED: static red still causes full refreshes.\n", stderr); return 2;
  }
  return 0;
}
