#include <stdio.h>
#include <string.h>
#include "../test_check.h"
#include "quiet_dashboard.h"
#include "display_sync_policy.h"
#include "display_text.h"

static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t shown[EPD_CANVAS_BUFFER_SIZE], offline[EPD_CANVAS_BUFFER_SIZE];
static unsigned full_calls, quiet_calls;
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *c, uint32_t *ms) {
  memcpy(shown, c->black, sizeof(shown));
  *ms = 16000; full_calls++;
  return ESP_OK;
}
esp_err_t epd_quiet_refresh(const epd_canvas_t *c, const uint8_t *previous,
                           size_t size, unsigned y, unsigned height,
                           epd_quiet_metrics_t *timing) {
  CHECK(size == sizeof(shown) && !memcmp(previous, shown, size));
  CHECK(y < 300 && height > 0 && y + height <= 300);
  for (size_t i = 0; i < sizeof(red); i++) CHECK(c->red[i] == 0xff);
  memcpy(shown, c->black, sizeof(shown));
  memset(timing, 0, sizeof(*timing)); timing->total_ms = 3000;
  quiet_calls++;
  return ESP_OK;
}
static void save(const char *name) {
  FILE *file = fopen(name, "wb"); CHECK(file);
  fprintf(file, "P5\n400 300\n255\n");
  for (unsigned i = 0; i < 120000; i++)
    fputc(black[i / 8] & (128u >> (i % 8)) ? 255 : 0, file);
  CHECK(fclose(file) == 0);
}
static codepulse_ui_model_t model(bool inverted) {
  codepulse_ui_model_t m = {
    .wifi_connected = true, .thread_count = 2, .thread_total = 2,
    .display = {.valid = true, .hud = true, .remaining = true,
                .show_quota = true, .agent_mask = 3, .inverted = inverted},
    .agent_count = 2,
    .agents = {{CODEPULSE_UI_AGENT_CLAUDE, CODEPULSE_UI_AGENT_RUNNING, 16, 70},
               {CODEPULSE_UI_AGENT_CODEX, CODEPULSE_UI_AGENT_DONE, -1, 85}},
  };
  strcpy(m.threads[0].id, "retained-task-a");
  strcpy(m.threads[0].title, "状态同步测试");
  strcpy(m.threads[0].state_reason, "thinking");
  m.threads[0].state = CODEPULSE_UI_AGENT_RUNNING;
  m.threads[0].level = CODEPULSE_LEVEL_ACTIVE;
  strcpy(m.threads[1].id, "retained-task-b");
  strcpy(m.threads[1].title, "待查看任务");
  m.threads[1].state = CODEPULSE_UI_AGENT_DONE;
  m.threads[1].level = CODEPULSE_LEVEL_NOTICE;
  m.threads[1].type = CODEPULSE_UI_AGENT_CODEX;
  return m;
}
static void check_offline(bool inverted) {
  epd_canvas_t canvas = {black, red};
  codepulse_ui_model_t m = model(inverted), target;
  display_sync_policy_t policy = {0};
  quiet_dashboard_t screen = {0};
  quiet_dashboard_result_t result;
  CHECK(quiet_dashboard_update(&screen, &canvas, &m, 0, &result) == ESP_OK);
  CHECK(result.full);
  display_sync_record_attempt(&policy, 0, &m, true);
  const unsigned initial_full = full_calls, initial_quiet = quiet_calls;
  m.wifi_connected = false; m.work_status_stale = true;
  CHECK(display_sync_evaluate(&policy, 1000, &m) == DISPLAY_SYNC_NONE);
  display_sync_project(&policy, 1000, &m, false, &target);
  CHECK(!target.work_status_stale && target.wifi_connected);
  CHECK(display_sync_evaluate(&policy, 4000, &m) == DISPLAY_SYNC_CONNECTIVITY);
  display_sync_project(&policy, 4000, &m, false, &target);
  CHECK(target.work_status_stale && !target.wifi_connected);
  CHECK(target.threads[0].state == CODEPULSE_UI_AGENT_RUNNING);
  CHECK(!strcmp(target.threads[0].id, "retained-task-a"));
  CHECK(target.thread_count == 2);
  CHECK(quiet_dashboard_update(&screen, &canvas, &target, 4000, &result) == ESP_OK);
  CHECK(result.changed && !result.full && quiet_calls == initial_quiet + 1);
  display_sync_record_attempt(&policy, 7000, &target, true);
  memcpy(offline, black, sizeof(offline));
  save(inverted ? "offline-inverted.pgm" : "offline.pgm");

  // A stale screen uses a transport label, never an old running/action badge.
  // Suppression is visual only; canonical host task fields are not rewritten.
  codepulse_ui_model_t alternate = target;
  alternate.threads[0].state = CODEPULSE_UI_AGENT_WAITING;
  alternate.threads[0].level = CODEPULSE_LEVEL_ACTION;
  strcpy(alternate.threads[0].state_reason, "waiting_permission");
  strcpy(alternate.threads[0].detail, "Old sensitive activity");
  const codepulse_ui_model_t before = alternate;
  quiet_dashboard_render(&canvas, &alternate);
  CHECK(!memcmp(black, offline, sizeof(offline)));
  CHECK(!memcmp(&before, &alternate, sizeof(before)));
  for (unsigned i = 0; i < 120; i++) {
    CHECK(display_sync_evaluate(&policy, 7100 + i * 1000, &m) == DISPLAY_SYNC_NONE);
    CHECK(quiet_dashboard_update(&screen, &canvas, &m, 7100 + i * 1000, &result) == ESP_OK);
    CHECK(!result.changed);
  }
  CHECK(full_calls == initial_full && quiet_calls == initial_quiet + 1);

  // Reconnect with exactly the same revision/state: connectivity alone restores
  // live labels. This must not depend on a new task notification arriving.
  m.wifi_connected = true; m.work_status_stale = false;
  CHECK(display_sync_evaluate(&policy, 140000, &m) == DISPLAY_SYNC_NONE);
  CHECK(display_sync_evaluate(&policy, 143000, &m) == DISPLAY_SYNC_CONNECTIVITY);
  display_sync_project(&policy, 143000, &m, false, &target);
  CHECK(!target.work_status_stale);
  CHECK(quiet_dashboard_update(&screen, &canvas, &target, 143000, &result) == ESP_OK);
  CHECK(result.changed && !result.full);
  CHECK(memcmp(black, offline, sizeof(offline)) != 0);
  CHECK(full_calls == initial_full && quiet_calls == initial_quiet + 2);
  display_sync_record_attempt(&policy, 146000, &target, true);
  CHECK(display_sync_evaluate(&policy, 146001, &m) == DISPLAY_SYNC_NONE);
  save(inverted ? "reconnected-inverted.pgm" : "reconnected.pgm");

  // Short Wi-Fi hiccups never produce an offline frame.
  m.wifi_connected = false; m.work_status_stale = true;
  CHECK(display_sync_evaluate(&policy, 147000, &m) == DISPLAY_SYNC_NONE);
  m.wifi_connected = true; m.work_status_stale = false;
  CHECK(display_sync_evaluate(&policy, 148000, &m) == DISPLAY_SYNC_NONE);
}
int main(void) {
  CHECK(display_text_init());
  CHECK(display_text_supports("离线电脑未连接"));
  check_offline(false); check_offline(true);
  puts("PASS: disconnect debounce, visual-only stale labels, stable offline frames, same-state reconnect and normal/inverted rendering");
  return 0;
}
