#include "quiet_dashboard.h"
#include "display_text.h"
#include "life_dashboard.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const codepulse_ui_agent_type_t order[] = {
    CODEPULSE_UI_AGENT_CLAUDE, CODEPULSE_UI_AGENT_CODEX, CODEPULSE_UI_AGENT_GROK};
static codepulse_ui_agent_t agent(const codepulse_ui_model_t *m,
                                  codepulse_ui_agent_type_t type) {
  for (size_t i = 0; i < m->agent_count && i < CODEPULSE_UI_MAX_AGENTS; i++)
    if (m->agents[i].type == type) return m->agents[i];
  return (codepulse_ui_agent_t){type, CODEPULSE_UI_AGENT_OFFLINE, -1, -1};
}
static const char *name(codepulse_ui_agent_type_t t) {
  return t == CODEPULSE_UI_AGENT_CODEX ? "Codex" :
         t == CODEPULSE_UI_AGENT_CLAUDE ? "Claude" : "Grok";
}
static const char *state_name(codepulse_ui_agent_state_t s) {
  switch (s) {
  case CODEPULSE_UI_AGENT_WAITING: return "待确认";
  case CODEPULSE_UI_AGENT_DONE: return "待查看";
  case CODEPULSE_UI_AGENT_ERROR: return "异常";
  case CODEPULSE_UI_AGENT_LIMITED: return "受限";
  case CODEPULSE_UI_AGENT_RUNNING: return "工作中";
  case CODEPULSE_UI_AGENT_IDLE: return "空闲";
  default: return "离线";
  }
}
static bool selected(const codepulse_ui_model_t *m, codepulse_ui_agent_type_t t) {
  return !m->display.valid || (m->display.agent_mask & (1u << t)) != 0;
}
static bool remaining(const codepulse_ui_model_t *m) {
  return m->display.valid && m->display.remaining;
}
static void percent(char *out, size_t size, int used, bool rem) {
  if (used < 0) snprintf(out, size, "--%%");
  else snprintf(out, size, "%d%%", rem ? 100 - (used > 100 ? 100 : used) : (used > 100 ? 100 : used));
}
static void type(epd_canvas_t *c, display_font_t f, int x, int baseline,
                 const char *s, display_align_t align) {
  display_font_run(c, f, x, baseline, s, align, EPD_COLOR_BLACK);
}
static void line(epd_canvas_t *c, int x, int y, int ex, int ey) {
  int dx = abs(ex - x), sx = x < ex ? 1 : -1, dy = -abs(ey - y),
      sy = y < ey ? 1 : -1, err = dx + dy;
  for (;;) {
    epd_canvas_pixel(c, x, y, EPD_COLOR_BLACK);
    if (x == ex && y == ey) break;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}
static void rounded_color(epd_canvas_t *c, int x, int y, int w, int h, epd_color_t color) {
  /* Radius-four 1-bit corners, shared with the approved 400x300 study. */
  static const int cuts[] = {3, 1, 1, 0};
  for (int row = 0; row < h; row++) {
    int edge = row < h - row - 1 ? row : h - row - 1;
    int cut = edge < 4 ? cuts[edge] : 0;
    epd_canvas_fill_rect(c, x + cut, y + row, w - cut * 2, 1, color);
  }
}
static const char *thread_state_name(const codepulse_ui_thread_t *t) {
  if (t->state == CODEPULSE_UI_AGENT_DONE && codepulse_thread_level(t) == CODEPULSE_LEVEL_QUIET) return "已完成";
  if (!strcmp(t->state_reason, "cancelled")) return "已取消";
  if (!strcmp(t->state_reason, "timeout")) return "超时";
  if (!strcmp(t->state_reason, "waiting_user_input")) return "待补充";
  if (!strcmp(t->state_reason, "waiting_permission")) return "待授权";
  return state_name(t->state);
}
/* Task colours (approved HUD A, 2026-11-04): red needs you (action or fault), black is ready
 * to review, a black outline is working; quiet tasks are plain text. */
typedef enum { TONE_NONE, TONE_OUTLINE, TONE_BLACK, TONE_RED } tone_t;
static tone_t tone(const codepulse_ui_thread_t *t) {
  switch (codepulse_thread_level(t)) {
  case CODEPULSE_LEVEL_ACTION: case CODEPULSE_LEVEL_FAULT: return TONE_RED;
  case CODEPULSE_LEVEL_NOTICE: return TONE_BLACK;
  case CODEPULSE_LEVEL_ACTIVE: return TONE_OUTLINE;
  default: return TONE_NONE;
  }
}
static void outline(epd_canvas_t *c, int x, int y, int w, int h) {
  epd_canvas_fill_rect(c, x, y, w, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, x, y + h - 1, w, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, x, y, 1, h, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, x + w - 1, y, 1, h, EPD_COLOR_BLACK);
}
static void pill(epd_canvas_t *c, int x, int y, int w, int h, const codepulse_ui_thread_t *t,
                 display_font_t f) {
  const tone_t k = tone(t);
  const char *s = thread_state_name(t);
  display_text_bounds_t b = display_font_bounds(f, s);
  const int baseline = y + (h - (b.bottom - b.top) + 1) / 2 - b.top;
  epd_color_t ink = EPD_COLOR_BLACK;
  if (k == TONE_RED || k == TONE_BLACK) {
    rounded_color(c, x, y, w, h, k == TONE_RED ? EPD_COLOR_RED : EPD_COLOR_BLACK);
    ink = EPD_COLOR_WHITE;
  } else if (k == TONE_OUTLINE) outline(c, x, y, w, h);
  display_font_run(c, f, x + w / 2, baseline, s, DISPLAY_CENTER, ink);
}
/* Left colour bar for tasks that need you (red) or are ready to review (black). */
static void bar(epd_canvas_t *c, int y, int h, const codepulse_ui_thread_t *t) {
  const tone_t k = tone(t);
  if (k == TONE_RED || k == TONE_BLACK)
    epd_canvas_fill_rect(c, 12, y, 4, h, k == TONE_RED ? EPD_COLOR_RED : EPD_COLOR_BLACK);
}
static void fit(display_font_t f, const char *s, int width, char *out, size_t cap) {
  snprintf(out, cap, "%s", s);
  if (display_font_width(f, out) <= width) return;
  size_t n = strlen(out);
  while (n) {
    do n--; while (n && ((unsigned char)out[n] & 0xc0) == 0x80);
    if (n + 4 > cap) continue;
    strcpy(out + n, "…");
    if (display_font_width(f, out) <= width) return;
  }
}
/* Quota lives only in the footer; rows carry the task, its agent and its state. */
static void hud(epd_canvas_t *c, const codepulse_ui_model_t *m) {
  const size_t n = m->thread_count > 9 ? 9 : m->thread_count;
  if (!n) { type(c, DISPLAY_STATE, 200, 138, "暂无活动任务", DISPLAY_CENTER); return; }
  char text[200], clipped[200];
  if (n <= 3) {
    for (size_t i = 0; i < n; i++) {
      const codepulse_ui_thread_t *t = &m->threads[i];
      const int y = 32 + (int)i * 77;
      if (i) epd_canvas_fill_rect(c, 26, y - 1, 362, 1, EPD_COLOR_BLACK);
      bar(c, y + 4, 68, t);
      const int lines = display_font_block(c, DISPLAY_TITLE, 26, y + 24, 286, 2, 22, t->title, EPD_COLOR_BLACK);
      const char *detail = codepulse_thread_level(t) == CODEPULSE_LEVEL_ACTIVE ? "AI 正在处理任务" : t->detail;
      snprintf(text, sizeof(text), detail[0] ? "%s · %s" : "%s", name(t->type), detail);
      fit(DISPLAY_META, text, 286, clipped, sizeof(clipped));
      display_font_run(c, DISPLAY_META, 26, y + (lines > 1 ? 68 : 48), clipped, DISPLAY_LEFT,
                       tone(t) == TONE_RED ? EPD_COLOR_RED : EPD_COLOR_BLACK);
      pill(c, 322, y + 22, 66, 32, t, DISPLAY_BADGE);
    }
    return;
  }
  const int h = n > 6 ? 25 : 37;
  for (size_t i = 0; i < n; i++) {
    const codepulse_ui_thread_t *t = &m->threads[i];
    const int y = 33 + (int)i * h;
    if (i) epd_canvas_fill_rect(c, 26, y - 1, 362, 1, EPD_COLOR_BLACK);
    bar(c, y + 3, h - 6, t);
    fit(DISPLAY_TITLE, t->title, 200, clipped, sizeof(clipped));
    display_font_run(c, DISPLAY_TITLE, 26, y + h / 2 + 7, clipped, DISPLAY_LEFT, EPD_COLOR_BLACK);
    display_font_run(c, DISPLAY_META, 314, y + h / 2 + 6, name(t->type), DISPLAY_RIGHT, EPD_COLOR_BLACK);
    pill(c, 322, y + (h - 21) / 2, 66, 21, t, DISPLAY_META);
  }
}
static void usage(epd_canvas_t *c, const codepulse_ui_model_t *m) {
  int row = 0;
  for (unsigned i = 0; i < 3; i++) if (selected(m, order[i])) {
    int y = 34 + row++ * 76;
    codepulse_ui_agent_t a = agent(m, order[i]);
    if (row > 1) line(c, 12, y - 2, 387, y - 2);
    type(c, DISPLAY_USAGE_TITLE, 12, y + 27, name(order[i]), DISPLAY_LEFT);
    char value[12]; percent(value, sizeof(value), a.weekly_percent, remaining(m));
    type(c, DISPLAY_USAGE_NUMBER, 388, y + 35, value, DISPLAY_RIGHT);
    line(c, 12, y + 42, 387, y + 42);
    if (a.weekly_percent >= 0) {
      int amount = remaining(m) ? 100 - a.weekly_percent : a.weekly_percent;
      if (amount < 0) amount = 0;
      if (amount > 100) amount = 100;
      epd_canvas_fill_rect(c, 12, y + 40, (376 * amount + 50) / 100, 4, EPD_COLOR_BLACK);
    }
    type(c, DISPLAY_META, 12, y + 63, remaining(m) ? "周额度 · 剩余" : "周额度 · 已用", DISPLAY_LEFT);
    char detail[40];
    if (a.type == CODEPULSE_UI_AGENT_CLAUDE) {
      percent(value, sizeof(value), a.five_hour_percent, remaining(m));
      snprintf(detail, sizeof(detail), "5H %s", value);
    } else if (m->weekly_resets[a.type]) {
      const uint64_t local = m->weekly_resets[a.type] + 8 * 3600;
      const unsigned weekday = (unsigned)((local / 86400 + 4) % 7);
      const char *days[] = {"日", "一", "二", "三", "四", "五", "六"};
      snprintf(detail, sizeof(detail), "周%s %02u:%02u 重置", days[weekday],
               (unsigned)(local / 3600 % 24), (unsigned)(local / 60 % 60));
    } else snprintf(detail, sizeof(detail), "重置时间 --");
    type(c, DISPLAY_META, 388, y + 63, detail, DISPLAY_RIGHT);
  }
  if (!row) type(c, DISPLAY_STATE, 200, 138, "未选择账号", DISPLAY_CENTER);
}
static void footer(epd_canvas_t *c, const codepulse_ui_model_t *m, bool is_hud) {
  if (!m->display.valid || m->display.show_quota) {
    line(c, 12, 263, 387, 263);
    unsigned count = 0;
    for (unsigned i = 0; i < 3; i++) if (selected(m, order[i])) count++;
    if (!count) return;
    unsigned col = 0;
    for (unsigned i = 0; i < 3; i++) if (selected(m, order[i])) {
      const int x = 12 + (int)(col++ * 376 / count);
      const codepulse_ui_agent_t a = agent(m, order[i]);
      char label[64], week[12], five[12];
      snprintf(label, sizeof(label), "%s · %s", name(order[i]), remaining(m) ? "剩余" : "已用");
      type(c, DISPLAY_META, x, 278, label, DISPLAY_LEFT);
      percent(week, sizeof(week), a.weekly_percent, remaining(m));
      if (a.type == CODEPULSE_UI_AGENT_CLAUDE) {
        percent(five, sizeof(five), a.five_hour_percent, remaining(m));
        snprintf(label, sizeof(label), "5h %s  周 %s", five, week);
      } else snprintf(label, sizeof(label), "周 %s", week);
      type(c, DISPLAY_SUMMARY, x, 294, label, DISPLAY_LEFT);
    }
  } else {
    line(c, 12, 271, 387, 271);
    type(c, DISPLAY_META, 12, 290, is_hud ? "在电脑上处理提醒" : "账户额度独立统计", DISPLAY_LEFT);
  }
}
/* Every toolbar icon occupies the same 12x12 cell. */
static void icon(epd_canvas_t *c, int x, int y, const uint16_t rows[12]) {
  for (int row = 0; row < 12; row++) for (int col = 0; col < 12; col++)
    if (rows[row] & (0x800u >> col)) epd_canvas_pixel(c, x + col, y + row, EPD_COLOR_BLACK);
}
static void header(epd_canvas_t *c, const codepulse_ui_model_t *m, bool is_hud) {
  const int points[][2] = {{12,15},{15,15},{17,10},{20,21},{23,14},{25,14}};
  for (unsigned i = 1; i < sizeof(points) / sizeof(points[0]); i++)
    line(c, points[i-1][0], points[i-1][1], points[i][0], points[i][1]);
  type(c, DISPLAY_BRAND, 29, 20, "CodePulse", DISPLAY_LEFT);
  /* The task screen shows only the brand; other screens name themselves. */
  if (m->ambient || !is_hud) {
    line(c, 107, 10, 107, 21);
    type(c, DISPLAY_BRAND, 114, 20, m->ambient ? "动态" : "用量", DISPLAY_LEFT);
  }
  static const uint16_t thermo[12] = {0x000,0x060,0x090,0x090,0x0d0,0x0d0,0x0f0,0x0d0,0x1d8,0x168,0x090,0x060};
  static const uint16_t drop[12] = {0x000,0x040,0x0a0,0x090,0x110,0x208,0x204,0x402,0x402,0x402,0x204,0x1f8};
  static const uint16_t wifi[12] = {0x000,0x000,0x1f0,0x20c,0x402,0x8f1,0x108,0x264,0x090,0x060,0x000,0x000};
  if (!m->display.valid || m->display.show_environment) {
    char temp[20], hum[16];
    if (m->environment_valid) {
      snprintf(temp, sizeof(temp), "%.1f°C", (double)m->temperature_c);
      snprintf(hum, sizeof(hum), "%.0f%%", (double)m->humidity_rh);
    } else { snprintf(temp, sizeof(temp), "--.-°C"); snprintf(hum, sizeof(hum), "--%%"); }
    icon(c, 174, 9, thermo);
    /* Seven native bold16 characters fit before the humidity icon at x246. */
    display_font_block(c, DISPLAY_BRAND, 190, 20, 56, 1, 0, temp, EPD_COLOR_BLACK);
    icon(c, 246, 9, drop);
    display_font_block(c, DISPLAY_BRAND, 262, 20, 42, 1, 0, hum, EPD_COLOR_BLACK);
  }
  icon(c, 315, 9, wifi);
  if (!m->wifi_connected) line(c, 315, 20, 326, 9);
  char value[12];
  if (m->battery_valid) snprintf(value, sizeof(value), "%u%%", m->battery_percent);
  else snprintf(value, sizeof(value), "--%%");
  type(c, DISPLAY_BRAND, 369, 20, value, DISPLAY_RIGHT);
  line(c, 376, 11, 385, 11); line(c, 376, 18, 385, 18);
  line(c, 376, 11, 376, 18); line(c, 385, 11, 385, 18);
  line(c, 387, 13, 387, 16);
  if (m->battery_valid) epd_canvas_fill_rect(c, 378, 13, (m->battery_percent * 6 + 99) / 100, 4, EPD_COLOR_BLACK);
  line(c, 12, 30, 387, 30);
}
static void calendar_circle(epd_canvas_t *c, int cx, int cy, int diameter) {
  const int left = cx - diameter / 2, top = cy - diameter / 2;
  for (int y = top; y < top + diameter; y++) for (int x = left; x < left + diameter; x++)
    if (display_circle_pixel(x, y, cx, cy, diameter)) epd_canvas_pixel(c, x, y, EPD_COLOR_RED);
}
static void calendar_label(epd_canvas_t *c, int left, int right, int baseline,
                           const char *label, epd_color_t color) {
  if (display_font_width(DISPLAY_MICRO, label) <= right - left - 2)
    display_font_run(c, DISPLAY_MICRO, (left + right) / 2, baseline, label, DISPLAY_CENTER, color);
  else
    display_font_block(c, DISPLAY_MICRO, left + 1, baseline, right - left - 2, 1, 0, label, color);
}
static void calendar_battery(epd_canvas_t *c, const codepulse_ui_model_t *m) {
  epd_canvas_fill_rect(c, 374, 9, 14, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 374, 16, 14, 1, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 374, 10, 1, 6, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 387, 10, 1, 6, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(c, 388, 11, 2, 4, EPD_COLOR_BLACK);
  if (m->battery_valid)
    epd_canvas_fill_rect(c, 376, 11, (m->battery_percent * 10 + 99) / 100, 4, EPD_COLOR_BLACK);
}
static void calendar(epd_canvas_t *c, const codepulse_calendar_t *a, bool white_only, epd_color_t circle_ink) {
  char value[64];
  if (!white_only) {
    snprintf(value, sizeof(value), "%u", a->year);
    display_font_run(c, DISPLAY_DATE, 12, 29, value, DISPLAY_LEFT, EPD_COLOR_BLACK);
    int x = 12 + display_font_width(DISPLAY_DATE, value) + 4;
    type(c, DISPLAY_STATE, x, 29, "年", DISPLAY_LEFT); x += 19;
    snprintf(value, sizeof(value), "%u", a->month);
    display_font_run(c, DISPLAY_DATE, x, 29, value, DISPLAY_LEFT, EPD_COLOR_RED);
    x += display_font_width(DISPLAY_DATE, value) + 4;
    type(c, DISPLAY_STATE, x, 29, "月", DISPLAY_LEFT);
    if (display_font_width(DISPLAY_MICRO, a->lunar) <= 166) {
      display_font_run(c, DISPLAY_MICRO, 366, 13, a->lunar, DISPLAY_RIGHT, EPD_COLOR_BLACK);
      snprintf(value, sizeof(value), "第%u周", a->week);
      display_font_run(c, DISPLAY_MICRO, 388, 34, value, DISPLAY_RIGHT, EPD_COLOR_BLACK);
    } else {
      snprintf(value, sizeof(value), "%s · 第%u周", a->lunar, a->week);
      display_font_block(c, DISPLAY_MICRO, 200, 13, 166, 3, 13, value, EPD_COLOR_BLACK);
    }
    const char *weekdays[] = {"一", "二", "三", "四", "五", "六", "日"};
    for (unsigned col = 0; col < 7; col++) {
      const int left = 12 + (int)(col * 376 / 7), right = 12 + (int)((col + 1) * 376 / 7);
      epd_canvas_fill_rect(c, left, 42, right - left - 1, 18, col < 5 ? EPD_COLOR_BLACK : EPD_COLOR_RED);
      display_font_run(c, DISPLAY_MICRO, (left + right) / 2, 56, weekdays[col], DISPLAY_CENTER, EPD_COLOR_WHITE);
    }
  }
  const unsigned rows = (a->first + a->days + 6u) / 7u;
  const display_font_t date_font = rows == 6 ? DISPLAY_TITLE : DISPLAY_DATE;
  const display_text_bounds_t digits = display_font_bounds(date_font, "0123456789");
  display_text_bounds_t labels = display_font_bounds(DISPLAY_MICRO, "初一");
  for (unsigned i = 0; i < a->days; i++) {
    const display_text_bounds_t b = display_font_bounds(DISPLAY_MICRO, a->labels[i]);
    if (b.top < labels.top) labels.top = b.top;
    if (b.bottom > labels.bottom) labels.bottom = b.bottom;
  }
  const int dh = digits.bottom - digits.top, lh = labels.bottom - labels.top;
  for (unsigned day = 1; day <= a->days; day++) {
    const bool today = day == a->today;
    if (white_only && !today) continue;
    const unsigned cell = a->first + day - 1, row = cell / 7, col = cell % 7;
    const int left = 12 + (int)(col * 376 / 7), right = 12 + (int)((col + 1) * 376 / 7);
    const int top = 63 + (int)(row * 235 / rows), end = 63 + (int)((row + 1) * 235 / rows);
    const int cx = (left + right) / 2, cy = (top + end) / 2;
    const unsigned flags = a->flags[day - 1]; const char *label = a->labels[day - 1];
    const int start = top + (end - top - dh - 2 - lh) / 2;
    int number_base = start - digits.top;
    int label_base = rows == 6 ? end - 1 - labels.bottom : start + dh + 2 - labels.top;
    snprintf(value, sizeof(value), "%u", day);
    if (!today) {
      display_font_run(c, date_font, cx - ((flags & 8) ? 3 : 0), number_base, value, DISPLAY_CENTER,
                       (flags & 5) ? EPD_COLOR_RED : EPD_COLOR_BLACK);
      calendar_label(c, left, right, label_base, label, (flags & 7) ? EPD_COLOR_RED : EPD_COLOR_BLACK);
    } else {
      int diameter = end - top - 1; if (diameter > 46) diameter = 46;
      display_font_t number_font = date_font;
      int circle_cy = cy;
      const int group_top = cy - (dh + 2 + lh) / 2;
      number_base = label[0] ? group_top - digits.top : cy - (digits.top + digits.bottom) / 2;
      const int circle_label_base = group_top + dh + 2 - labels.top;
      const bool label_inside = display_font_circle_fit(number_font, cx, number_base, value, DISPLAY_CENTER, cx, circle_cy, diameter) &&
          display_font_circle_fit(DISPLAY_MICRO, cx, circle_label_base, label, DISPLAY_CENTER, cx, circle_cy, diameter);
      if (label_inside) label_base = circle_label_base;
      else {
        /* Reserve the unchanged normal label row below a date-only circle.
         * Use a smaller native strike if required; never crop white strokes. */
        diameter = label_base + labels.top - top - 1;
        if (diameter > 46) diameter = 46;
        circle_cy = top + diameter / 2;
        const display_font_t choices[] = {date_font, DISPLAY_TITLE, DISPLAY_NUMBER, DISPLAY_SUMMARY, DISPLAY_BRAND};
        for (unsigned i = 0; i < sizeof(choices) / sizeof(choices[0]); i++) {
          const display_text_bounds_t b = display_font_bounds(choices[i], "0123456789");
          number_base = circle_cy - (b.top + b.bottom) / 2;
          number_font = choices[i];
          if (display_font_circle_fit(number_font, cx, number_base, value, DISPLAY_CENTER, cx, circle_cy, diameter)) break;
        }
      }
      if (!white_only) calendar_circle(c, cx, circle_cy, diameter);
      display_font_run(c, number_font, cx, number_base, value, DISPLAY_CENTER, circle_ink);
      if (label_inside)
        display_font_run(c, DISPLAY_MICRO, cx, label_base, label, DISPLAY_CENTER, circle_ink);
      else if (!white_only)
        calendar_label(c, left, right, label_base, label, EPD_COLOR_RED);
    }
    if (!white_only && (flags & 8)) {
      /* Today's disc can reach the badge corner: keep a white halo between them. */
      if (today)
        for (int dy = -1; dy <= 1; dy++)
          for (int dx = -1; dx <= 1; dx++)
            if (dx || dy)
              display_font_run(c, DISPLAY_MICRO, right - 1 + dx, top + 12 + dy, "班", DISPLAY_RIGHT, EPD_COLOR_WHITE);
      display_font_run(c, DISPLAY_MICRO, right - 1, top + 12, "班", DISPLAY_RIGHT, EPD_COLOR_BLACK);
    }
  }
}
static void ambient(epd_canvas_t *c, const codepulse_ambient_t *a) {
  if (a->layout == CODEPULSE_AMBIENT_LAYOUT_LIFE && life_dashboard_render(c, &a->life)) {
    return;
  }
  if (a->layout == CODEPULSE_AMBIENT_LAYOUT_CALENDAR) { calendar(c, &a->calendar, false, EPD_COLOR_WHITE); return; }
  const bool pet = a->has_image && a->layout == CODEPULSE_AMBIENT_LAYOUT_PET;
  const unsigned image_y = pet ? 32 : 60;
  if (!pet) display_font_block(c, DISPLAY_META, 12, 52, 376, 1, 0, a->source, EPD_COLOR_BLACK);
  if (a->has_items) {
    if (!a->item_count) display_font_block(c, DISPLAY_TITLE, 12, 98, 376, 3, 26, "今天的待办已完成。留一点时间给自己。", EPD_COLOR_BLACK);
    for (size_t i=0;i<a->item_count;i++) {
      const codepulse_ambient_item_t *item=&a->items[i];
      int y=78+(int)i*28;
      line(c,13,y-10,21,y-10);line(c,13,y-2,21,y-2);line(c,13,y-10,13,y-2);line(c,21,y-10,21,y-2);
      if(item->overdue) epd_canvas_fill_rect(c,15,y-8,5,5,EPD_COLOR_BLACK);
      display_font_block(c,DISPLAY_BODY,30,y,252,1,0,item->title,EPD_COLOR_BLACK);
      type(c,DISPLAY_META,387,y,item->meta,DISPLAY_RIGHT);
      if(i+1<a->item_count)line(c,30,y+7,387,y+7);
    }
    type(c, DISPLAY_META, 12, 250, "待办 · 在电脑上完成或更改", DISPLAY_LEFT);
  } else if (a->has_image) {
    for (unsigned y = 0; y < CODEPULSE_AMBIENT_HEIGHT; y++)
      for (unsigned x = 0; x < CODEPULSE_AMBIENT_WIDTH; x++) {
        unsigned bit = y * CODEPULSE_AMBIENT_WIDTH + x;
        if (a->image[bit / 8] & (0x80u >> (bit % 8))) epd_canvas_pixel(c, 8 + x, image_y + y, EPD_COLOR_BLACK);
      }
    if (a->has_red)
      for (unsigned y = 0; y < a->red_h; y++)
        for (unsigned x = 0; x < a->red_w; x++) {
          unsigned bit = y * a->red_w + x;
          unsigned bw = (a->red_y + y) * CODEPULSE_AMBIENT_WIDTH + a->red_x + x;
          if ((a->red[bit / 8] & (0x80u >> (bit % 8))) &&
              !(a->image[bw / 8] & (0x80u >> (bw % 8))))
            epd_canvas_pixel(c, 8 + a->red_x + x, image_y + a->red_y + y, EPD_COLOR_RED);
        }
    if (pet) {
      const bool wide = display_font_width(DISPLAY_TITLE, a->text) > 376;
      display_font_block(c, wide ? DISPLAY_META : DISPLAY_TITLE, 12, wide ? 266 : 268,
                          376, 1, 0, a->text, EPD_COLOR_BLACK);
      display_font_block(c, DISPLAY_META, 12, 293, 376, 1, 0, a->source, EPD_COLOR_BLACK);
    } else display_font_block(c, DISPLAY_META, 12, 290, 376, 1, 0, a->text, EPD_COLOR_BLACK);
  } else {
    display_font_block(c, DISPLAY_TITLE, 12, 76, 376, 8, 20, a->text, EPD_COLOR_BLACK);
    type(c, DISPLAY_META, 12, 250, "多媒体 · 在电脑上管理内容", DISPLAY_LEFT);
  }
}

void quiet_dashboard_render(epd_canvas_t *c, const codepulse_ui_model_t *m) {
  epd_canvas_clear(c, EPD_COLOR_WHITE);
  if (!display_text_init()) return;
  bool is_hud = m->display.valid && m->display.hud;
  const bool is_calendar = m->ambient && m->ambient->layout == CODEPULSE_AMBIENT_LAYOUT_CALENDAR;
  if (!is_calendar) header(c, m, is_hud);
  if (m->ambient) ambient(c, m->ambient);
  else if (is_hud) hud(c, m); else usage(c, m);
  if (m->ambient && m->ambient->layout == CODEPULSE_AMBIENT_LAYOUT_CALENDAR) {
    calendar_battery(c, m);
  } else if (m->ambient && m->ambient->has_image) {
    const int y = m->ambient->layout == CODEPULSE_AMBIENT_LAYOUT_PET ? 243 : 271;
    line(c, 12, y, 387, y);
  } else footer(c, m, is_hud);
  /* Red stays red; its black bit must remain white even in inverted mode. */
  if (m->display.valid && m->display.inverted)
    for (size_t i = 0; i < EPD_CANVAS_BUFFER_SIZE; ++i)
      c->black[i] = (uint8_t)(~c->black[i] | ~c->red[i]);
  if (is_calendar && m->display.valid && m->display.inverted)
    calendar(c, &m->ambient->calendar, true, EPD_COLOR_WHITE);
}

esp_err_t quiet_dashboard_update(quiet_dashboard_t *s, epd_canvas_t *c,
                                 const codepulse_ui_model_t *m, int64_t now_ms,
                                 quiet_dashboard_result_t *r) {
  if (!s || !c || !c->black || !c->red || !m || !r)
    return ESP_ERR_INVALID_ARG;
  memset(r, 0, sizeof(*r));
  if (s->faulted)
    return ESP_ERR_INVALID_STATE;
  if (!display_text_init())
    return ESP_ERR_NO_MEM;
  quiet_dashboard_render(c, m);
  const bool fold_red = s->initialized && !s->previous_has_red && s->has_runtime_full &&
      (now_ms < s->last_full_ms || now_ms - s->last_full_ms < CODEPULSE_RED_FULL_COOLDOWN_MS);
  const bool inverted = m->display.valid && m->display.inverted;
  if (fold_red && inverted && m->ambient && m->ambient->layout == CODEPULSE_AMBIENT_LAYOUT_CALENDAR)
    /* There is no red circle in this BW downgrade: retain contrast on its
     * white foreground ink without changing the full-refresh/cooldown gate. */
    calendar(c, &m->ambient->calendar, true, EPD_COLOR_BLACK);
  bool has_red = false;
  uint32_t checksum = 2166136261u;
  for (size_t i = 0; i < EPD_CANVAS_BUFFER_SIZE; i++) {
    if (fold_red) {
      /* Fold red into foreground ink; inverted red already has a white bit. */
      if (!inverted) c->black[i] &= c->red[i];
      c->red[i] = 0xff;
    }
    if (c->red[i] != 0xff) has_red = true;
    checksum = (checksum ^ c->red[i]) * 16777619u;
  }
  esp_err_t err = ESP_OK;
  if (!s->initialized) {
    r->full = r->changed = true;
    r->height = BOARD_EPD_HEIGHT;
    err = epd_ssd1683_refresh(c, &r->timing.total_ms);
  } else {
    unsigned first = BOARD_EPD_HEIGHT, end = 0;
    for (unsigned y = 0; y < BOARD_EPD_HEIGHT; y++)
      if (memcmp(c->black + y * 50u, s->previous + y * 50u, 50)) {
        if (y < first)
          first = y;
        end = y + 1;
      }
    if (first == BOARD_EPD_HEIGHT && checksum == s->red_checksum)
      return ESP_OK;
    r->changed = true;
    if (has_red || s->previous_has_red) {
      r->full = r->red_full = true;
      r->height = BOARD_EPD_HEIGHT;
      err = epd_ssd1683_refresh(c, &r->timing.total_ms);
    } else {
      /* One bounding BW window, never one drive per card/column. The quiet
       * driver still rejects color; failures never trigger an OTP fallback. */
      r->y = first;
      r->height = end - first;
      err = epd_quiet_refresh(c, s->previous, sizeof(s->previous), r->y,
                              r->height, &r->timing);
    }
  }
  if (err == ESP_OK) {
    if (r->red_full) {
      s->has_runtime_full = true;
      s->last_full_ms = now_ms + r->timing.total_ms;
    }
    memcpy(s->previous, c->black, sizeof(s->previous));
    s->previous_has_red = has_red;
    s->red_checksum = checksum;
    s->initialized = true;
  } else
    s->faulted = true;
  return err;
}
