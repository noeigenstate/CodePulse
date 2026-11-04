#define main legacy_dashboard_main
#include "test_dashboard.c"
#undef main

static codepulse_ambient_t card = {
  .id = "calendar:2026-10-30", .source = "日历", .text = "calendar fallback",
  .layout = CODEPULSE_AMBIENT_LAYOUT_CALENDAR,
  .calendar = {.year = 2026, .month = 10, .first = 3, .days = 31, .week = 44, .lunar = "丙午年 九月廿一"}
};
static uint8_t before_black[EPD_CANVAS_BUFFER_SIZE], before_red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t normal_black[EPD_CANVAS_BUFFER_SIZE], normal_red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t expected_black[EPD_CANVAS_BUFFER_SIZE], expected_red[EPD_CANVAS_BUFFER_SIZE];
static unsigned circles_checked, boundaries_checked;
static bool ink(const uint8_t *plane, int x, int y) {
  return !(plane[y * 50 + x / 8] & (0x80u >> (x % 8)));
}
static void cell(unsigned day, int *left, int *right, int *top, int *end) {
  const unsigned index = card.calendar.first + day - 1, col = index % 7, row = index / 7;
  const unsigned rows = (card.calendar.first + card.calendar.days + 6u) / 7u;
  *left = 12 + (int)(col * 376 / 7); *right = 12 + (int)((col + 1) * 376 / 7);
  *top = 63 + (int)(row * 235 / rows); *end = 63 + (int)((row + 1) * 235 / rows);
}
static void month(unsigned rows) {
  card.calendar.year = (uint16_t)(rows == 4 ? 2027 : 2026);
  card.calendar.month = (uint8_t)(rows == 4 ? 2 : rows == 5 ? 10 : 8);
  card.calendar.first = (uint8_t)(rows == 4 ? 0 : rows == 5 ? 3 : 5);
  card.calendar.days = (uint8_t)(rows == 4 ? 28 : 31);
  card.calendar.today = 0; memset(card.calendar.flags, 0, sizeof(card.calendar.flags));
  /* Fix the month-wide envelope while testing one cell's 0..4 glyph label. */
  for (unsigned i = 0; i < 31; i++) strcpy(card.calendar.labels[i], "Ág中");
}
static void circle_bounds(int left, int right, int top, int end, int *cx, int *cy, int *diameter) {
  const unsigned rows = (card.calendar.first + card.calendar.days + 6u) / 7u;
  const display_text_bounds_t digits = display_font_bounds(rows == 6 ? DISPLAY_TITLE : DISPLAY_DATE, "0123456789");
  display_text_bounds_t labels = display_font_bounds(DISPLAY_MICRO, "??");
  for (unsigned i = 0; i < card.calendar.days; i++) {
    display_text_bounds_t b = display_font_bounds(DISPLAY_MICRO, card.calendar.labels[i]);
    if (b.top < labels.top) labels.top = b.top;
    if (b.bottom > labels.bottom) labels.bottom = b.bottom;
  }
  const int dh = digits.bottom - digits.top, lh = labels.bottom - labels.top;
  const int label_top = rows == 6 ? end - 1 - lh : top + (end - top - dh - 2 - lh) / 2 + dh + 2;
  /* This region includes the circle's horizontal diameter but excludes an
   * external red label. Aggregate all components: white strokes can split red. */
  int min_x = 400, min_y = 300, max_x = 0, max_y = 0;
  for (int y = top; y < label_top; y++) for (int x = left; x < right; x++) if (ink(red,x,y)) {
    if (x < min_x) min_x = x; if (x > max_x) max_x = x;
    if (y < min_y) min_y = y; if (y > max_y) max_y = y;
  }
  CHECK(min_x <= max_x && min_y <= max_y);
  *diameter = max_x - min_x + 1; *cx = min_x + *diameter / 2; *cy = min_y + *diameter / 2;
  CHECK(*diameter >= 12 && *diameter <= 46);
  for (int y = top; y < label_top; y++) for (int x = left; x < right; x++)
    if (ink(red,x,y)) CHECK(display_circle_pixel(x,y,*cx,*cy,*diameter));
}
static void render_tests(void) {
  month(5); epd_canvas_t c = {black, red}, expected = {expected_black, expected_red};
  codepulse_ui_model_t m = model(0); m.ambient = &card;
  quiet_dashboard_render(&c, &m);
  memcpy(before_black, black, sizeof(black)); memcpy(before_red, red, sizeof(red));
  m.temperature_c += 10; m.humidity_rh += 20; m.wifi_connected = !m.wifi_connected;
  quiet_dashboard_render(&c, &m);
  CHECK(!memcmp(before_black, black, sizeof(black)) && !memcmp(before_red, red, sizeof(red)));
  CHECK(ink(black, 374, 9)); /* Battery is retained; other telemetry is absent. */
  for (unsigned col = 0; col < 7; col++) {
    const int x = 14 + (int)(col * 376 / 7);
    CHECK(ink(black, x, 42) == (col < 5) && ink(red, x, 42) == (col >= 5));
  }
  for (int y = 63; y < 110; y++) for (int x = 12; x < 173; x++) CHECK(!ink(black, x, y) && !ink(red, x, y));
  for (int y = 251; y < 298; y++) for (int x = 334; x < 388; x++) CHECK(!ink(black, x, y) && !ink(red, x, y));
  card.calendar.flags[7] = 1; quiet_dashboard_render(&c, &m);
  memcpy(before_black, black, sizeof(black)); memcpy(before_red, red, sizeof(red));
  card.calendar.flags[7] = 4; quiet_dashboard_render(&c, &m);
  CHECK(!memcmp(before_black, black, sizeof(black)) && !memcmp(before_red, red, sizeof(red))); /* No rest mark. */
  int left, right, top, end; cell(8, &left, &right, &top, &end);
  card.calendar.flags[7] = 8; quiet_dashboard_render(&c, &m);
  epd_canvas_clear(&expected, EPD_COLOR_WHITE);
  display_font_run(&expected, DISPLAY_MICRO, right - 1, top + 12, "班", DISPLAY_RIGHT, EPD_COLOR_BLACK);
  unsigned mark = 0;
  for (int y = top; y < top + 14; y++) for (int x = right - 14; x < right; x++) {
    CHECK(ink(black, x, y) == ink(expected_black, x, y)); CHECK(!ink(red, x, y));
    if (ink(black, x, y)) mark++;
  }
  CHECK(mark > 0);
}
static void label_and_circle_tests(void) {
  /* Native bold16's WWWW is narrow (32px). Keep it, and retain a genuinely
   * wide four-character pressure case from the closed 12px vocabulary. */
  const char *labels[] = {"", "月", "初一", "国庆节", "重阳节", "春节快乐", "四字标签", "WWWW"};
  epd_canvas_t c = {black, red}; codepulse_ui_model_t m = model(0); m.ambient = &card;
  for (unsigned rows = 4; rows <= 6; rows++) {
    for (unsigned i = 0; i < sizeof(labels)/sizeof(labels[0]); i++) {
      for (unsigned position = 0; position < 4; position++) {
        month(rows); const unsigned day = position == 0 ? 1 : position == 1 ? 2 : position == 2 ? 17 : card.calendar.days;
        int left, right, top, end; cell(day, &left, &right, &top, &end);
        card.calendar.labels[day-1][0] = 0; m.display.inverted = false;
        quiet_dashboard_render(&c, &m); memcpy(before_black, black, sizeof(black)); memcpy(before_red, red, sizeof(red));
        strcpy(card.calendar.labels[day-1], labels[i]); quiet_dashboard_render(&c, &m);
        /* Changing this label must not paint a neighboring date cell. */
        for (int y = 0; y < 300; y++) for (int x = 0; x < 400; x++)
          if (x < left || x >= right || y < top || y >= end) {
            CHECK(ink(black,x,y) == ink(before_black,x,y)); CHECK(ink(red,x,y) == ink(before_red,x,y));
          }
        boundaries_checked++;
        memcpy(before_black, black, sizeof(black)); memcpy(before_red, red, sizeof(red));
        card.calendar.today = (uint8_t)day; quiet_dashboard_render(&c, &m);
        int cx, cy, diameter; circle_bounds(left, right, top, end, &cx, &cy, &diameter);
        CHECK(cx-diameter/2 >= left && cx-diameter/2+diameter <= right);
        CHECK(cy-diameter/2 >= top && cy-diameter/2+diameter <= end);
        unsigned white = 0;
        for (int y = top; y < end; y++) for (int x = left; x < right; x++)
          if (display_circle_pixel(x,y,cx,cy,diameter) && !ink(red,x,y)) { CHECK(!ink(black,x,y)); white++; }
        CHECK(white > 8);
        if (i == 5 || i == 6) {
          unsigned outside_label = 0;
          for (int y = cy-diameter/2+diameter; y < end; y++) for (int x = left; x < right; x++)
            if (ink(before_black,x,y)) { CHECK(ink(red,x,y) && !ink(black,x,y)); outside_label++; }
          CHECK(outside_label > 8); /* The complete long label stays on its normal row. */
        }
        memcpy(normal_black, black, sizeof(black)); memcpy(normal_red, red, sizeof(red));
        m.display.inverted = true; quiet_dashboard_render(&c, &m);
        CHECK(!memcmp(normal_red, red, sizeof(red)));
        for (int y = 0; y < 300; y++) for (int x = 0; x < 400; x++) {
          const bool expected_ink = !ink(normal_red,x,y) && !ink(normal_black,x,y);
          if (ink(black,x,y) != expected_ink) {
            CHECK(display_circle_pixel(x,y,cx,cy,diameter));
            CHECK(!ink(black,x,y) && !ink(red,x,y));
          }
          if (display_circle_pixel(x,y,cx,cy,diameter) && !ink(red,x,y)) CHECK(!ink(black,x,y));
        }
        circles_checked++;
      }
    }
  }
  for (unsigned k = 0; k < 6; k++) {
    const unsigned long_label = k % 2; month(4 + k / 2);
    const unsigned day = card.calendar.days;
    card.calendar.today = (uint8_t)day; card.calendar.flags[day-1] = 8;
    strcpy(card.calendar.labels[day-1], long_label ? "春节快乐" : "初一");
    m.display.inverted = false; quiet_dashboard_render(&c, &m);
    int left, right, top, end, cx, cy, diameter; cell(day, &left, &right, &top, &end);
    circle_bounds(left, right, top, end, &cx, &cy, &diameter);
    CHECK(cx-diameter/2 >= left && cx-diameter/2+diameter <= right);
    CHECK(cy-diameter/2 >= top && cy-diameter/2+diameter <= end);
    /* The black workday badge never touches today's red disc. */
    unsigned badge = 0;
    for (int y = top; y < top + 16; y++) for (int x = right - 16; x < right; x++) if (ink(black,x,y)) {
      badge++;
      for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) CHECK(!ink(red,x+dx,y+dy));
    }
    CHECK(badge > 8);
    memcpy(normal_black, black, sizeof(black)); memcpy(normal_red, red, sizeof(red));
    m.display.inverted = true; quiet_dashboard_render(&c, &m);
    CHECK(!memcmp(normal_red, red, sizeof(red)));
    for (int y = 0; y < 300; y++) for (int x = 0; x < 400; x++) {
      const bool expected_ink = !ink(normal_red,x,y) && !ink(normal_black,x,y);
      if (ink(black,x,y) != expected_ink) {
        CHECK(display_circle_pixel(x,y,cx,cy,diameter)); CHECK(!ink(black,x,y) && !ink(red,x,y));
      }
    }
    circles_checked++;
  }
}
static void refresh_tests(void) {
  epd_canvas_t c = {black, red}; quiet_dashboard_t s = {0}; quiet_dashboard_result_t r;
  codepulse_ui_model_t m = model(0);
  CHECK(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full);
  m.ambient = &card; strcpy(m.ambient_id, card.id);
  CHECK(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && r.red_full && s.previous_has_red);
  CHECK(quiet_dashboard_update(&s, &c, &m, s.last_full_ms, &r) == ESP_OK && !r.changed);
  m.ambient = NULL; m.ambient_id[0] = 0;
  CHECK(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 1, &r) == ESP_OK && r.red_full && !s.previous_has_red);
  const int64_t left = s.last_full_ms;
  m.ambient = &card; strcpy(m.ambient_id, card.id);
  CHECK(quiet_dashboard_update(&s, &c, &m, left + 1, &r) == ESP_OK && !r.full && !s.previous_has_red);
  for (size_t i = 0; i < sizeof(red); i++) CHECK(red[i] == 255 && physical_red[i] == 255);
  display_sync_policy_t p = {0}; display_sync_record_attempt(&p, left + 1, &m, true);
  CHECK(display_sync_evaluate(&p, left + 120000, &m) == DISPLAY_SYNC_NONE);
  CHECK(quiet_dashboard_update(&s, &c, &m, left + 120000, &r) == ESP_OK && r.red_full && s.previous_has_red);
  /* A real red circle keeps white text; an inverted BW downgrade must not
   * collapse its white circle and white foreground into invisible text. */
  m.display.inverted = false; quiet_dashboard_render(&c, &m);
  for (size_t i = 0; i < sizeof(black); i++) expected_black[i] = (uint8_t)(black[i] & red[i]);
  s = (quiet_dashboard_t){0}; m.display.inverted = true; m.ambient = NULL;
  CHECK(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full);
  m.ambient = &card;
  CHECK(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && r.red_full);
  m.ambient = NULL;
  CHECK(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 1, &r) == ESP_OK && r.red_full);
  m.ambient = &card;
  CHECK(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 1, &r) == ESP_OK && !r.full && !s.previous_has_red);
  for (size_t i = 0; i < sizeof(black); i++) {
    CHECK(red[i] == 255 && physical_red[i] == 255);
    CHECK(black[i] == (uint8_t)~expected_black[i]);
  }
}
int main(void) {
  render_tests(); label_and_circle_tests(); refresh_tests();
  printf("PASS: full-screen calendar/battery, no rest marks, work marks, %u label-neighbor checks, %u exact circle/white-inversion checks, 4/5/6 rows and refresh policy\n", boundaries_checked, circles_checked);
  return 0;
}
