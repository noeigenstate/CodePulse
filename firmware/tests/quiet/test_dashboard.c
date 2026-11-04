#include "display_sync_policy.h"
#include "display_text.h"
#include "quiet_dashboard.h"
#include <assert.h>
#include "../test_check.h"
#include <stdio.h>
#include <string.h>

static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE],
    physical[EPD_CANVAS_BUFFER_SIZE], physical_red[EPD_CANVAS_BUFFER_SIZE];
static unsigned full_calls, partial_calls, last_y, last_end;
static bool fail_next;
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *c, uint32_t *duration) {
  ++full_calls;
  *duration = 15903;
  for (size_t i = 0; i < sizeof(red); i++)
    CHECK((c->black[i] | c->red[i]) == 255);
  if (fail_next) {
    fail_next = false;
    return ESP_FAIL;
  }
  memcpy(physical, c->black, sizeof(physical));
  memcpy(physical_red, c->red, sizeof(physical_red));
  return ESP_OK;
}
esp_err_t epd_quiet_refresh(const epd_canvas_t *c, const uint8_t *old,
                            size_t size, unsigned y, unsigned height,
                            epd_quiet_metrics_t *metrics) {
  ++partial_calls;
  CHECK(size == sizeof(physical) && !memcmp(old, physical, size));
  unsigned first = 300, end = 0;
  for (unsigned row = 0; row < 300; row++)
    if (memcmp(physical + row * 50, c->black + row * 50, 50)) {
      if (row < first)
        first = row;
      end = row + 1;
    }
  CHECK(y == first && y + height == end && height > 0 && end <= 300);
  last_y = y;
  last_end = end;
  for (size_t i = 0; i < sizeof(red); i++)
    CHECK(c->red[i] == 255 && physical_red[i] == 255);
  if (fail_next) {
    fail_next = false;
    return ESP_FAIL;
  }
  memcpy(physical, c->black, size);
  metrics->refresh_ms = 2633;
  return ESP_OK;
}
static codepulse_ui_model_t model(unsigned count) {
  codepulse_ui_model_t m = {
      .display = {.valid = true,
                  .hud = true,
                  .remaining = true,
                  .show_quota = true,
                  .show_environment = true,
                  .agent_mask = 7},
      .thread_count = count,
      .thread_total = count,
      .environment_valid = true,
      .temperature_c = 30.9f,
      .humidity_rh = 52,
      .battery_valid = true,
      .battery_percent = 72,
      .wifi_connected = true,
      .agent_count = 3,
      .agents = {
          {CODEPULSE_UI_AGENT_CLAUDE, CODEPULSE_UI_AGENT_OFFLINE, 30, 9},
          {CODEPULSE_UI_AGENT_CODEX, CODEPULSE_UI_AGENT_WAITING, -1, 53},
          {CODEPULSE_UI_AGENT_GROK, CODEPULSE_UI_AGENT_OFFLINE, -1, -1}}};
  const char *titles[] = {"CodePulse · 低闪烁看板", "固件 · 状态同步",
                          "HUD · 桌面布局"};
  const char *details[] = {"运行测试需要你的确认", "检查显示区域与状态映射",
                           "界面调整完成，等待查看"};
  for (unsigned i = 0; i < count; i++) {
    snprintf(m.threads[i].id, sizeof(m.threads[i].id), "thread-%u", i);
    snprintf(m.threads[i].title, sizeof(m.threads[i].title), "%s",
             titles[i % 3]);
    snprintf(m.threads[i].detail, sizeof(m.threads[i].detail), "%s",
             details[i % 3]);
    m.threads[i].type =
        i % 3 == 1 ? CODEPULSE_UI_AGENT_CLAUDE : CODEPULSE_UI_AGENT_CODEX;
    m.threads[i].state = i % 3 == 0   ? CODEPULSE_UI_AGENT_WAITING
                         : i % 3 == 1 ? CODEPULSE_UI_AGENT_RUNNING
                                      : CODEPULSE_UI_AGENT_DONE;
  }
  return m;
}
static void save(const char *name) {
  FILE *f = fopen(name, "wb");
  CHECK(f);
  fprintf(f, "P5\n400 300\n255\n");
  for (unsigned y = 0; y < 300; y++)
    for (unsigned x = 0; x < 400; x++)
      fputc((black[y * 50 + x / 8] & (0x80u >> (x % 8))) ? 255 : 0, f);
  fclose(f);
}
static void policy_tests(void) {
  codepulse_ui_model_t m = model(3), out;
  display_sync_policy_t p = {0};
  display_sync_record_attempt(&p, 0, &m, true);
  m.temperature_c += 0.4f; m.humidity_rh += 2; m.battery_percent += 2;
  CHECK(display_sync_evaluate(&p, 1, &m) == DISPLAY_SYNC_NONE);
  m.threads[0].state = CODEPULSE_UI_AGENT_RUNNING;
  m.agents[1].weekly_percent = 54;
  CHECK(display_sync_evaluate(&p, 2, &m) == DISPLAY_SYNC_AGENT_STATE);
  display_sync_project(&p, 2, &m, false, &out);
  CHECK(out.threads[0].state == CODEPULSE_UI_AGENT_RUNNING && out.agents[1].weekly_percent == 53);
  CHECK(out.temperature_c == 30.9f && out.humidity_rh == 52 && out.battery_percent == 72);
  display_sync_record_attempt(&p, 3, &out, true);
  CHECK(display_sync_evaluate(&p, 4, &m) == DISPLAY_SYNC_NONE);
  strcpy(m.threads[0].detail, "tool chatter");
  CHECK(display_sync_evaluate(&p, 5, &m) == DISPLAY_SYNC_NONE);
  m.agents[1].weekly_percent++;
  display_sync_project(&p, 6, &m, false, &out);
  CHECK(strcmp(out.threads[0].detail, "tool chatter"));
  m.threads[0].state = CODEPULSE_UI_AGENT_WAITING;
  CHECK(display_sync_evaluate(&p, 7, &m) == DISPLAY_SYNC_ATTENTION);
  display_sync_project(&p, 7, &m, false, &out);
  CHECK(out.threads[0].state == CODEPULSE_UI_AGENT_WAITING && !strcmp(out.threads[0].detail, "tool chatter"));
  display_sync_record_attempt(&p, 8, &out, true);

  // A new ordinary card and a new urgent card both bypass list settling.
  m = model(4); m.threads[3].state = CODEPULSE_UI_AGENT_RUNNING;
  CHECK(display_sync_evaluate(&p, 9, &m) == DISPLAY_SYNC_AGENT_STATE);
  display_sync_project(&p, 9, &m, false, &out); CHECK(out.thread_count == 4);
  m.threads[3].state = CODEPULSE_UI_AGENT_WAITING;
  CHECK(display_sync_evaluate(&p, 10, &m) == DISPLAY_SYNC_ATTENTION);
  display_sync_record_attempt(&p, 11, &m, true);
  strcpy(m.threads[3].title, "renamed task");
  CHECK(display_sync_evaluate(&p, 12, &m) == DISPLAY_SYNC_AGENT_STATE);
  display_sync_project(&p, 12, &m, false, &out);
  CHECK(!strcmp(out.threads[3].title, "renamed task"));
  display_sync_record_attempt(&p, 13, &out, true);
  m.thread_count--; m.thread_total--;
  CHECK(display_sync_evaluate(&p, 14, &m) == DISPLAY_SYNC_AGENT_STATE);
  m.display.hud = false;
  CHECK(display_sync_evaluate(&p, 15, &m) == DISPLAY_SYNC_LAYOUT);
  display_sync_project(&p, 15, &m, false, &out);
  display_sync_record_attempt(&p, 16, &out, true);
  m.threads[0].state = CODEPULSE_UI_AGENT_ERROR;
  m.agents[0].state = CODEPULSE_UI_AGENT_RUNNING;
  CHECK(display_sync_evaluate(&p, 17, &m) == DISPLAY_SYNC_NONE);
  m.display.hud = true; m.display.show_quota = false; m.display.show_environment = false;
  display_sync_project(&p, 18, &m, false, &out);
  display_sync_record_attempt(&p, 18, &out, true);
  m.agents[1].weekly_percent = 90; m.temperature_c = 40;
  CHECK(display_sync_evaluate(&p, 1800000, &m) == DISPLAY_SYNC_NONE);

  // While one waveform runs, retain the latest snapshot, not intermediate
  // notifications. Old pixels for the next drive are the successful frame.
  epd_canvas_t c = {black, red}; quiet_dashboard_t screen = {0};
  quiet_dashboard_result_t result;
  m = model(3); p = (display_sync_policy_t){0};
  CHECK(quiet_dashboard_update(&screen, &c, &m, 0, &result) == ESP_OK);
  display_sync_record_attempt(&p, 0, &m, true);
  const unsigned full_before = full_calls;
  for (unsigned i = 1; i <= 40; i++) {
    m.threads[0].state = i % 2 ? CODEPULSE_UI_AGENT_DONE : CODEPULSE_UI_AGENT_RUNNING;
    CHECK(display_sync_evaluate(&p, i, &m) != DISPLAY_SYNC_NONE);
    display_sync_project(&p, i, &m, false, &out);
    CHECK(quiet_dashboard_update(&screen, &c, &out, i, &result) == ESP_OK && !result.full);
    display_sync_record_attempt(&p, i, &out, true);
  }
  CHECK(full_calls == full_before);
}
int main(void) {
  epd_canvas_t c = {black, red};
  quiet_dashboard_t s = {0};
  quiet_dashboard_result_t r;
  codepulse_ui_model_t m = model(3);
  CHECK(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full);
  save("display-hud-3.pgm");
  CHECK(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && !r.changed);
  for (int state = 0; state <= CODEPULSE_UI_AGENT_LIMITED; state++) {
    m.threads[0].state = (codepulse_ui_agent_state_t)state;
    CHECK(quiet_dashboard_update(&s, &c, &m, 2, &r) == ESP_OK);
    if (r.changed)
      CHECK(last_y >= 34 && last_end <= 110);
  }
  const unsigned counts[] = {0, 1, 2, 4, 6, 7, 9};
  for (unsigned j = 0; j < sizeof(counts) / sizeof(counts[0]); j++) {
    m = model(counts[j]);
    CHECK(quiet_dashboard_update(&s, &c, &m, 3, &r) == ESP_OK && !r.full);
    char file[40];
    snprintf(file, sizeof(file), "display-hud-%u.pgm", counts[j]);
    save(file);
    for (unsigned i = 0; i < m.thread_count; i++) {
      m.threads[i].state = CODEPULSE_UI_AGENT_DONE;
      CHECK(quiet_dashboard_update(&s, &c, &m, 4, &r) == ESP_OK);
      if (r.changed)
        CHECK(last_y >= 34 + (i % 3) * 76 &&
               last_end <= 34 + (i % 3 + 1) * 76);
    }
  }
  m.display.hud = false;
  CHECK(quiet_dashboard_update(&s, &c, &m, 5, &r) == ESP_OK && !r.full);
  save("display-usage.pgm");
  CHECK(full_calls == 1);
  m.agents[1].weekly_percent = 100;
  fail_next = true;
  CHECK(quiet_dashboard_update(&s, &c, &m, 6, &r) == ESP_FAIL && s.faulted);
  CHECK(!memcmp(s.previous, physical, sizeof(physical)));
  unsigned calls = partial_calls;
  CHECK(quiet_dashboard_update(&s, &c, &m, 7, &r) == ESP_ERR_INVALID_STATE &&
         partial_calls == calls && full_calls == 1);
  quiet_dashboard_t failed = {0};
  fail_next = true;
  CHECK(quiet_dashboard_update(&failed, &c, &m, 8, &r) == ESP_FAIL &&
         failed.faulted && !failed.initialized);
  CHECK(quiet_dashboard_update(&failed, &c, &m, 9, &r) == ESP_ERR_INVALID_STATE &&
         full_calls == 2);
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_text(&c, 10, 10, 20, 1, "中文标题很长", EPD_COLOR_BLACK);
  for (unsigned y = 0; y < 300; y++)
    for (unsigned x = 30; x < 400; x++)
      CHECK(black[y * 50 + x / 8] & (0x80u >> (x % 8)));
  CHECK(display_text_width("WWW") == 24 && display_text_width("iii") == 24); /* Native Terminus16n grid. */
  CHECK(display_text_width("周剩余") == 48);
  CHECK(display_font_width(DISPLAY_TITLE, "中文标题") == 64);
  display_text_bounds_t title_ink = display_font_bounds(DISPLAY_TITLE, "中文");
  display_text_bounds_t body_ink = display_font_bounds(DISPLAY_BODY, "中文");
  CHECK(title_ink.top == body_ink.top && title_ink.bottom == body_ink.bottom); /* Both native ZhengGe16, no synthetic bold. */
  CHECK(display_text_supports("−") && display_text_width("−") == display_text_width("–"));
  CHECK(display_font_width(DISPLAY_TITLE, "Codex") == display_font_width(DISPLAY_USAGE_TITLE, "Codex"));
  CHECK(display_font_width(DISPLAY_TITLE, "Codex") > display_font_width(DISPLAY_META, "Codex"));
  CHECK(display_text_width("周剩余") <= 56);
  CHECK(display_font_width(DISPLAY_BADGE, "待确认") <= 52);
  CHECK(display_font_width(DISPLAY_SMALL_BOLD, "待查看") <= 52);
  CHECK(display_font_width(DISPLAY_TITLE, "CodePulse · 低闪烁看板") <= 254);
  CHECK(display_text_width("\xe4\xb8") > 0); /* truncated UTF-8 */
  CHECK(display_text_width("\xff") > 0);
  CHECK(display_text_width("\xf0\x9f\x98\x80") >
         0); /* unsupported glyph fallback */
  CHECK(display_text_init());
  /* One packed spacing rule fits the native title without rewriting its text. */
  m = model(9);
  strcpy(m.threads[0].title, "固件 · 状态同步");
  quiet_dashboard_render(&c, &m);
  memcpy(physical, black, sizeof(black));
  CHECK(!strcmp(m.threads[0].title, "固件 · 状态同步"));
  strcpy(m.threads[0].title, "固件·状态同步");
  quiet_dashboard_render(&c, &m);
  CHECK(display_font_width(DISPLAY_TITLE, "固件 · 状态同步") <= 117);
  CHECK(display_font_lines(DISPLAY_TITLE,117,2,"固件 · 状态同步") == 1);
  CHECK(memcmp(physical, black, sizeof(black)) != 0); /* Spaces retain their real narrow advances. */
  /* The original bold weight and complete negative reading fit before x246. */
  m = model(0);
  m.environment_valid = true;
  m.temperature_c = -40.0f;
  m.humidity_rh = 50.0f;
  m.display.show_environment = true;
  quiet_dashboard_render(&c, &m);
  memcpy(physical, black, sizeof(black));
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_font_run(&c, DISPLAY_MICRO, 190, 20, "-40.0°C", DISPLAY_LEFT, EPD_COLOR_BLACK);
  for (unsigned yy = 4; yy < 29; yy++) {
    for (unsigned xx = 190; xx < 246; xx++) {
      CHECK((black[yy*50+xx/8] & (128u>>(xx%8))) == (physical[yy*50+xx/8] & (128u>>(xx%8))));
    }
  }
  for (int font = 0; font < DISPLAY_FONT_COUNT; font++) {
    epd_canvas_clear(&c, EPD_COLOR_WHITE);
    display_font_text(&c, (display_font_t)font, 10, 10, 31, 2,
                      "长标题ABC123需要截断", EPD_COLOR_BLACK);
    for (unsigned y = 0; y < 300; y++)
      for (unsigned x = 0; x < 400; x++)
        if (x < 10 || x >= 41 || y < 10 ||
            y >= 10 + 2 * (unsigned)display_font_height((display_font_t)font))
          CHECK(black[y * 50 + x / 8] & (0x80u >> (x % 8)));
  }
  m = model(3);
  quiet_dashboard_render(&c, &m);
  unsigned ink = 0, white = 0;
  for (unsigned y = 47; y < 87; y++)
    for (unsigned x = 334; x < 388; x++) {
      if (black[y * 50 + x / 8] & (0x80u >> (x % 8)))
        white++;
      else
        ink++;
    }
  CHECK(ink > 1300 &&
         white > 100); /* filled badge plus legible reversed glyphs */
  /* Long titles use two lines and suppress detail instead of colliding. */
  snprintf(m.threads[0].title, sizeof(m.threads[0].title),
           "一个很长的中文项目标题需要完整显示但是最终仍然需要省略");
  quiet_dashboard_render(&c, &m);
  save("display-long-title.pgm");
  m = model(1);
  m.display.show_quota = false;
  m.display.show_environment = false;
  quiet_dashboard_render(&c, &m);
  save("display-minimal.pgm");
  m = model(2);
  snprintf(m.threads[0].title, sizeof(m.threads[0].title), "CodePulse");
  snprintf(m.threads[0].detail, sizeof(m.threads[0].detail), "AI 正在生成响应");
  m.threads[0].state = CODEPULSE_UI_AGENT_RUNNING;
  snprintf(m.threads[1].title, sizeof(m.threads[1].title), "jp-work-proxy");
  snprintf(m.threads[1].detail, sizeof(m.threads[1].detail), "本轮任务已完成");
  m.threads[1].type = CODEPULSE_UI_AGENT_CODEX;
  m.threads[1].state = CODEPULSE_UI_AGENT_DONE;
  m.agents[1].weekly_percent = 86;
  m.temperature_c = 33;
  m.humidity_rh = 35;
  m.battery_percent = 95;
  quiet_dashboard_render(&c, &m);
  save("display-live-font.pgm");
  /* Native 16px title j must retain its descender below the baseline. */
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_font_run(&c, DISPLAY_TITLE, 10, 25, "j", DISPLAY_LEFT, EPD_COLOR_BLACK);
  unsigned descender = 0;
  for (unsigned y = 26; y < 32; y++)
    for (unsigned x = 10; x < 20; x++)
      if (!(black[y * 50 + x / 8] & (0x80u >> (x % 8))))
        descender++;
  CHECK(descender > 0);
  /* Export exact renderer pixels for independent native-source comparison. */
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  const char *specimen = "在电脑上处理提醒 周剩余 待确认";
  display_font_text(&c, DISPLAY_BODY, 8, 8, 384, 1, specimen, EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_BADGE, 8, 40, 384, 1,
                    "待确认 待查看 工作中", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_BODY, 8, 72, 384, 1,
                    "CodePulse WWW iii jp-work-proxy 47%", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_TITLE, 8, 104, 384, 1,
                    "CodePulse WWW jp-work 47%", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_META, 8, 136, 384, 1,
                    "Codex 30.9 C 52% Claude Grok 100%", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_NUMBER, 8, 168, 384, 1,
                    "0123456789-%.", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_USAGE_NUMBER, 8, 200, 384, 1,
                    "0123456789-%.", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_TITLE, 8, 232, 384, 1,
                    "低闪烁看板 固件 状态同步 桌面布局", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_USAGE_TITLE, 8, 262, 384, 1,
                    "Codex Claude Grok", EPD_COLOR_BLACK);
  save("display-font-cells.pgm");
  const int wrap_width = display_font_width(DISPLAY_TITLE, "CodePulse ·");
  /* Wrapped title spaces must not consume the next line's useful width. */
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_font_text(&c, DISPLAY_TITLE, 8, 8, wrap_width, 2,
                    "CodePulse · 低闪烁看板", EPD_COLOR_BLACK);
  memcpy(physical, black, sizeof(physical));
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_font_text(&c, DISPLAY_TITLE, 8, 8, wrap_width, 1,
                    "CodePulse ·", EPD_COLOR_BLACK);
  display_font_text(&c, DISPLAY_TITLE, 8, 8 + display_font_height(DISPLAY_TITLE), wrap_width, 1,
                    "低闪烁看板", EPD_COLOR_BLACK);
  CHECK(!memcmp(physical, black, sizeof(physical)));
  /* Reserve the ellipsis even when the final CJK glyph alone overflows. */
  const char *tokens[] = {"open-water", "project_2026-v1", "v1.2_3-id"};
  for (unsigned token = 0; token < sizeof(tokens) / sizeof(tokens[0]); token++) {
    char joined[96]; snprintf(joined, sizeof(joined), "ab %s", tokens[token]);
    const int word_width = display_font_width(DISPLAY_TITLE, tokens[token]);
    epd_canvas_clear(&c, EPD_COLOR_WHITE);
    display_font_text(&c, DISPLAY_TITLE, 8, 8, word_width, 2, joined, EPD_COLOR_BLACK);
    memcpy(physical, black, sizeof(physical));
    epd_canvas_clear(&c, EPD_COLOR_WHITE);
    display_font_text(&c, DISPLAY_TITLE, 8, 8, word_width, 1, "ab", EPD_COLOR_BLACK);
    display_font_text(&c, DISPLAY_TITLE, 8, 8 + display_font_height(DISPLAY_TITLE), word_width, 1, tokens[token], EPD_COLOR_BLACK);
    CHECK(!memcmp(physical, black, sizeof(physical)));
  }
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_font_text(&c, DISPLAY_TITLE, 8, 8, display_font_width(DISPLAY_TITLE, "AB…"), 1,
                    "AB中文", EPD_COLOR_BLACK);
  memcpy(physical, black, sizeof(physical));
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_font_text(&c, DISPLAY_TITLE, 8, 8, display_font_width(DISPLAY_TITLE, "AB…"), 1,
                    "AB…", EPD_COLOR_BLACK);
  CHECK(!memcmp(physical, black, sizeof(physical)));
  /* Selected quota remains visible in the footer even with no matching task. */
  for (unsigned n = 0; n <= 1; n++) {
    codepulse_ui_model_t a = model(n);
    display_sync_policy_t p = {0};
    display_sync_record_attempt(&p, 0, &a, true);
    a.agents[0].weekly_percent++;
    CHECK(display_sync_evaluate(&p, 1, &a) == DISPLAY_SYNC_NONE);
    CHECK(display_sync_evaluate(&p, 180000, &a) == DISPLAY_SYNC_QUOTA);
    a.display.agent_mask &= ~(1u << CODEPULSE_UI_AGENT_CLAUDE);
    display_sync_record_attempt(&p, 180000, &a, true);
    a.agents[0].weekly_percent++;
    CHECK(display_sync_evaluate(&p, 360000, &a) == DISPLAY_SYNC_NONE);
  }
  policy_tests();
  puts("PASS: 3/4/6/7/9 Chinese layouts, exact dirty bounds, no full fallback, "
       "OLD chain, failure latch, immediate states, sensor noise, hidden "
       "data");
  return 0;
}
