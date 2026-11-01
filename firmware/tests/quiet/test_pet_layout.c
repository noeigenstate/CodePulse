/* Share the panel transport assertions with the existing dashboard tests. */
#define main legacy_dashboard_main
#include "test_dashboard.c"
#undef main
/* Inspect the same private UTF-8 lookup/atlas used by production drawing. */
#include "../../main/display_text.c"

static uint8_t expected_black[EPD_CANVAS_BUFFER_SIZE], expected_red[EPD_CANVAS_BUFFER_SIZE];
static codepulse_ambient_t pet = {
  .id = "pet:cat:idle:2026-10-30", .source = "像素宠物 · 团团", .text = "我在晒太阳，你忙你的。",
  .has_image = true, .has_red = true, .red_w = 8, .red_h = 1, .red = {0xc0},
  .layout = CODEPULSE_AMBIENT_LAYOUT_PET
};
static bool ink(const uint8_t *plane, unsigned x, unsigned y) {
  return !(plane[y * 50 + x / 8] & (0x80u >> (x % 8)));
}
static const char *const sources[] = {
  "像素宠物 · 团团", "像素宠物 · 芽芽", "像素宠物 · 方方"
};
static const char *const captions[] = {
  "我在晒太阳，你忙你的。", "你敲你的，我替你盯着。", "额度见底了……能续点口粮吗？",
  "搞定啦！今晚的小鱼干有着落了。", "夜深了，我先窝着，晚安。",
  "我在长高，你也慢慢来。", "戴上眼镜，陪你一起看。", "叶子耷拉了，浇点额度吧。",
  "你又长出一片新叶子！", "光合作用暂停，明早见。",
  "系统待机，心情平稳。", "Agent 在跑，我在旁边待命。", "电量告急，求一格额度。",
  "任务完成，开心指数 100%。", "进入夜间模式，晚安。"
};
static bool covered(display_font_t font, unsigned cp) {
  if (cp == 0xfffd) return true;
  const glyph_t g = glyph(font, cp), fallback = glyph(font, 0xfffd);
  return g.bits != fallback.bits || g.advance != fallback.advance || g.width != fallback.width ||
         g.height != fallback.height || g.left != fallback.left || g.top != fallback.top;
}
static void text_coverage(display_font_t font, const char *text) {
  while (*text) CHECK(covered(font, next(&text)));
}
static void coverage_tests(void) {
  CHECK(display_text_init());
  unsigned title = 0, meta = 0, state = 0;
  for (unsigned i = 0; i < DISPLAY_FONT_GLYPHS; i++) {
    const unsigned cp = font_codes[i];
    const bool title_has = covered(DISPLAY_TITLE, cp), meta_has = covered(DISPLAY_META, cp);
    CHECK(title_has == meta_has);
    title += title_has; meta += meta_has; state += covered(DISPLAY_STATE, cp);
  }
  CHECK(title == DISPLAY_FONT_GLYPHS && meta == title && state == meta);
  for (int f = 0; f < DISPLAY_FONT_COUNT; f++)
    for (unsigned i = 0; i < DISPLAY_FONT_GLYPHS; i++)
      CHECK(covered((display_font_t)f, font_codes[i]));
  /* Calendar vocabulary keeps native12; other micro glyphs share body14. */
  const glyph_t spring = glyph(DISPLAY_MICRO, 0x6625);
  CHECK(spring.advance == 12);
  const unsigned fallback_codes[] = {0x6d4b, 0x8bd5, 0xfffd};
  for (unsigned i = 0; i < sizeof(fallback_codes) / sizeof(fallback_codes[0]); i++) {
    const glyph_t micro = glyph(DISPLAY_MICRO, fallback_codes[i]);
    const glyph_t body = glyph(DISPLAY_BODY, fallback_codes[i]);
    CHECK(micro.bits == body.bits && micro.advance == body.advance && micro.width == body.width &&
          micro.height == body.height && micro.left == body.left && micro.top == body.top);
  }
  for (unsigned i = 0; i < sizeof(captions) / sizeof(captions[0]); i++) {
    const display_font_t selected = display_font_width(DISPLAY_TITLE, captions[i]) > 376 ? DISPLAY_META : DISPLAY_TITLE;
    text_coverage(selected, captions[i]);
    text_coverage(DISPLAY_META, captions[i]);
  }
  for (unsigned i = 0; i < sizeof(sources) / sizeof(sources[0]); i++) text_coverage(DISPLAY_META, sources[i]);
  printf("PASS: font glyph records (including U+FFFD) TITLE=%u META=%u STATE=%u; identical title/meta coverage, all 15 captions and 3 sources covered\n", title, meta, state);
}
static void caption_test(const char *text, display_font_t font, int baseline, bool hud) {
  epd_canvas_t c = {black, red}, expected = {expected_black, expected_red};
  codepulse_ui_model_t m = model(0); m.display.hud = hud;
  m.ambient = &pet; pet.layout = CODEPULSE_AMBIENT_LAYOUT_LEGACY;
  quiet_dashboard_render(&c, &m);
  epd_canvas_clear(&expected, EPD_COLOR_WHITE);
  memcpy(expected_black, black, 31 * 50); /* Header, including y=30, is unchanged. */
  strcpy(pet.text, text); pet.layout = CODEPULSE_AMBIENT_LAYOUT_PET;
  quiet_dashboard_render(&c, &m);
  epd_canvas_pixel(&expected, 8, 32, EPD_COLOR_BLACK);
  epd_canvas_pixel(&expected, 9, 32, EPD_COLOR_RED);
  epd_canvas_pixel(&expected, 391, 239, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(&expected, 12, 243, 376, 1, EPD_COLOR_BLACK);
  display_font_block(&expected, font, 12, baseline, 376, 1, 0, text, EPD_COLOR_BLACK);
  display_font_block(&expected, DISPLAY_META, 12, 293, 376, 1, 0, pet.source, EPD_COLOR_BLACK);
  CHECK(!memcmp(black, expected_black, sizeof(black)));
  CHECK(!memcmp(red, expected_red, sizeof(red)));
  CHECK(ink(black, 8, 32) && !ink(red, 8, 32)); /* Black wins overlap. */
  CHECK(!ink(black, 9, 32) && ink(red, 9, 32));
  CHECK(ink(black, 391, 239) && !ink(black, 391, 240));
  for (unsigned x = 0; x < 400; x++) CHECK(ink(black, x, 243) == (x >= 12 && x <= 387));
  m.display.inverted = true; quiet_dashboard_render(&c, &m);
  CHECK(!memcmp(red, expected_red, sizeof(red)));
  for (size_t i = 0; i < sizeof(black); i++)
    CHECK(black[i] == (uint8_t)(~expected_black[i] | ~expected_red[i]));
}
static void render_tests(void) {
  pet.image[0] = 0x80; pet.image[CODEPULSE_AMBIENT_BYTES - 1] = 0x01;
  const char *short_text = "我在晒太阳，你忙你的。";
  CHECK(display_text_init() && display_font_width(DISPLAY_TITLE, short_text) <= 376);
  caption_test(short_text, DISPLAY_TITLE, 268, true);
  caption_test(short_text, DISPLAY_TITLE, 268, false);
  for (unsigned i = 0; i < sizeof(sources) / sizeof(sources[0]); i++) {
    strcpy(pet.source, sources[i]);
    caption_test(short_text, DISPLAY_TITLE, 268, true);
  }
  char long_text[241];
  for (unsigned i = 0; i < 80; i++) memcpy(long_text + i * 3, "中", 3);
  long_text[240] = 0;
  CHECK(display_font_width(DISPLAY_TITLE, long_text) > 376);
  CHECK(display_font_width(DISPLAY_META, long_text) > 376);
  caption_test(long_text, DISPLAY_META, 266, true);
  /* A caption that fits in the native 14px body must stay complete. */
  long_text[78] = 0;
  CHECK(display_font_width(DISPLAY_TITLE, long_text) > 376);
  CHECK(display_font_width(DISPLAY_META, long_text) <= 376);
  caption_test(long_text, DISPLAY_META, 266, true);
  strcpy(long_text + 66, "...."); /* Twenty-two 16px cells plus native punctuation. */
  CHECK(display_font_width(DISPLAY_TITLE, long_text) == 376);
  caption_test(long_text, DISPLAY_TITLE, 268, true);
  strcat(long_text, "1");
  CHECK(display_font_width(DISPLAY_TITLE, long_text) > 376);
  caption_test(long_text, DISPLAY_META, 266, true);
  const char *wide = "像素宠物 · 团团 像素宠物 · 芽芽 像素宠物 · 方方 像素宠物";
  CHECK(display_font_width(DISPLAY_TITLE, wide) > 376);
  text_coverage(DISPLAY_META, wide);
  caption_test(wide, DISPLAY_META, 266, true);
}
static void fallback_tests(void) {
  epd_canvas_t c = {black, red}; codepulse_ui_model_t m = model(0); m.ambient = &pet;
  pet.layout = CODEPULSE_AMBIENT_LAYOUT_LEGACY;
  quiet_dashboard_render(&c, &m);
  memcpy(expected_black, black, sizeof(black)); memcpy(expected_red, red, sizeof(red));
  pet.layout = (codepulse_ambient_layout_t)99;
  quiet_dashboard_render(&c, &m);
  CHECK(!memcmp(black, expected_black, sizeof(black)) && !memcmp(red, expected_red, sizeof(red)));
  pet.has_image = false; pet.layout = CODEPULSE_AMBIENT_LAYOUT_LEGACY;
  quiet_dashboard_render(&c, &m);
  memcpy(expected_black, black, sizeof(black)); memcpy(expected_red, red, sizeof(red));
  pet.layout = CODEPULSE_AMBIENT_LAYOUT_PET;
  quiet_dashboard_render(&c, &m);
  CHECK(!memcmp(black, expected_black, sizeof(black)) && !memcmp(red, expected_red, sizeof(red)));
  pet.has_image = true;
}
static void edge_tests(void) {
  epd_canvas_t c = {black, red}; codepulse_ui_model_t m = model(0); m.ambient = &pet;
  pet.red_x = 376; pet.red_y = 207; pet.red[0] = 0x81;
  pet.image[CODEPULSE_AMBIENT_BYTES - 1] = 0;
  quiet_dashboard_render(&c, &m);
  CHECK(ink(red, 384, 239) && ink(red, 391, 239));
  CHECK(!ink(red, 384, 267) && !ink(red, 391, 267));
  pet.red_x = pet.red_y = 0; pet.red[0] = 0xc0;
}
static void refresh_tests(void) {
  for (unsigned inverted = 0; inverted < 2; inverted++) {
    epd_canvas_t c = {black, red}; quiet_dashboard_t s = {0}; quiet_dashboard_result_t r;
    codepulse_ui_model_t m = model(0); m.ambient = &pet; m.display.inverted = inverted != 0;
    pet.has_red = true;
    CHECK(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full && !r.red_full);
    CHECK(ink(physical_red, 9, 32));
    pet.has_red = false;
    CHECK(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && r.red_full);
    const int64_t left = s.last_full_ms;
    pet.has_red = true;
    CHECK(quiet_dashboard_update(&s, &c, &m, left + 1, &r) == ESP_OK && r.changed && !r.full);
    CHECK(ink(physical, 9, 32) == !inverted && !s.previous_has_red);
    for (size_t i = 0; i < sizeof(red); i++) CHECK(red[i] == 255 && physical_red[i] == 255);
    CHECK(quiet_dashboard_update(&s, &c, &m, left + 2, &r) == ESP_OK && !r.changed);
    CHECK(quiet_dashboard_update(&s, &c, &m, left + 120000, &r) == ESP_OK && r.red_full);
    CHECK(ink(physical_red, 9, 32) && s.previous_has_red);
  }
}
static void scale_tests(void) {
  epd_canvas_t c = {black, red};
  epd_canvas_clear(&c, EPD_COLOR_WHITE);
  display_font_run(&c, DISPLAY_USAGE_NUMBER, 0, 16, "0123%", DISPLAY_LEFT, EPD_COLOR_BLACK);
  memcpy(expected_black, black, sizeof(black));
  for (int scale = 2; scale <= 3; scale++) for (int clipped = 0; clipped < 2; clipped++) {
    epd_canvas_clear(&c, EPD_COLOR_WHITE);
    display_font_run_scaled(&c, DISPLAY_USAGE_NUMBER, -clipped, 16 * scale, "0123%", DISPLAY_LEFT, EPD_COLOR_BLACK, scale);
    for (unsigned y = 0; y < 300; y++) for (unsigned x = 0; x < 400; x++)
      CHECK(ink(black, x, y) == ink(expected_black, (x + (unsigned)clipped) / (unsigned)scale, y / (unsigned)scale));
  }
}
int main(void) {
  coverage_tests(); render_tests(); fallback_tests(); edge_tests(); refresh_tests(); scale_tests();
  puts("PASS: full semantic coverage; native 16px SC caption, 14px body fallback/source, 376px boundary, legacy scale API compatibility, red bounds/inversion/cooldown");
  return 0;
}
