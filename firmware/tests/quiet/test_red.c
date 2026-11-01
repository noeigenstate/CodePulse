/* Reuse the transport assertions and the ordinary BW dashboard regression. */
#define main legacy_dashboard_main
#include "test_dashboard.c"
#undef main

static bool ink(const uint8_t *plane, unsigned x, unsigned y) {
  return !(plane[y * 50 + x / 8] & (0x80u >> (x % 8)));
}
static void white_red(void) {
  for (size_t i = 0; i < sizeof(red); i++) assert(red[i] == 255 && physical_red[i] == 255);
}
static codepulse_ambient_t pet = {
  .id = "pet:cat:calm:2026-10-29", .source = "pixel pet", .text = "quiet moment",
  .has_image = true, .has_red = true, .red_x = 128, .red_y = 40, .red_w = 16, .red_h = 2,
  .red = {0xc0, 0x01, 0x80, 0x01}
};
static void render_tests(void) {
  epd_canvas_t c = {black, red};
  codepulse_ui_model_t m = model(0); m.ambient = &pet;
  pet.image[40 * 48 + 16] = 0x80;
  quiet_dashboard_render(&c, &m);
  assert(ink(black, 136, 100) && !ink(red, 136, 100)); /* black wins overlap */
  assert(!ink(black, 137, 100) && ink(red, 137, 100));
  assert(ink(red, 151, 100) && ink(red, 136, 101) && ink(red, 151, 101));
  unsigned red_pixels = 0;
  for (unsigned y = 0; y < 300; y++) for (unsigned x = 0; x < 400; x++)
    if (ink(red, x, y)) red_pixels++;
  assert(red_pixels == 4);
  uint8_t normal_black[EPD_CANVAS_BUFFER_SIZE], normal_red[EPD_CANVAS_BUFFER_SIZE];
  memcpy(normal_black, black, sizeof(black)); memcpy(normal_red, red, sizeof(red));
  m.display.inverted = true; quiet_dashboard_render(&c, &m);
  assert(!memcmp(red, normal_red, sizeof(red)));
  for (unsigned y = 0; y < 300; y++) for (unsigned x = 0; x < 400; x++) {
    assert(ink(black, x, y) == (!ink(normal_red, x, y) && !ink(normal_black, x, y)));
    assert(!ink(black, x, y) || !ink(red, x, y));
  }
}
static void cooldown_fold_tests(void) {
  for (unsigned inverted = 0; inverted < 2; inverted++) {
    epd_canvas_t c = {black, red}; quiet_dashboard_t s = {0}; quiet_dashboard_result_t r;
    codepulse_ambient_t card = pet;
    codepulse_ui_model_t m = model(0); m.ambient = &card;
    m.display.inverted = inverted != 0;
    assert(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full);
    card.has_red = false;
    assert(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && r.red_full);
    const int64_t left = s.last_full_ms;
    const unsigned full_before = full_calls, quiet_before = partial_calls;
    card.has_red = true;
    assert(quiet_dashboard_update(&s, &c, &m, left + 1, &r) == ESP_OK && r.changed && !r.full);
    assert(!s.previous_has_red && s.last_full_ms == left);
    assert(full_calls == full_before && partial_calls == quiet_before + 1);
    /* Red becomes foreground ink: black bit 0 normally, 1 when inverted;
     * all red bits are 1. Include overlap, background and both sprite rows. */
    for (unsigned y = 0; y < card.red_h; y++) for (unsigned x = 0; x < card.red_w; x++) {
      const unsigned bit = y * card.red_w + x;
      const unsigned bw = (card.red_y + y) * CODEPULSE_AMBIENT_WIDTH + card.red_x + x;
      const bool pigment = (card.red[bit / 8] & (0x80u >> (bit % 8))) ||
                           (card.image[bw / 8] & (0x80u >> (bw % 8)));
      const bool expected_ink = inverted ? !pigment : pigment;
      const unsigned px = 8 + card.red_x + x, py = 60 + card.red_y + y;
      assert(ink(black, px, py) == expected_ink);
      assert(ink(physical, px, py) == expected_ink);
      assert(ink(s.previous, px, py) == expected_ink);
    }
    white_red();
    assert(quiet_dashboard_update(&s, &c, &m, left + 2, &r) == ESP_OK && !r.changed);
    assert(full_calls == full_before && partial_calls == quiet_before + 1);
  }
}
static void refresh_tests(void) {
  epd_canvas_t c = {black, red}; quiet_dashboard_t s = {0}; quiet_dashboard_result_t r;
  codepulse_ui_model_t m = model(0);
  assert(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full && !r.red_full);
  assert(!s.has_runtime_full && !s.previous_has_red);
  m.ambient = &pet; strcpy(m.ambient_id, pet.id);
  assert(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && r.red_full && r.changed);
  assert(r.full && r.y == 0 && r.height == 300 && s.previous_has_red && s.has_runtime_full);
  assert(s.last_full_ms == 1 + 15903 && ink(physical_red, 137, 100));
  assert(!memcmp(physical_red, red, sizeof(red)));
  const unsigned calls = full_calls;
  const int64_t entered = s.last_full_ms;
  assert(quiet_dashboard_update(&s, &c, &m, entered, &r) == ESP_OK && !r.changed);
  assert(full_calls == calls && s.last_full_ms == entered);
  uint32_t old_checksum = s.red_checksum;
  pet.red[0] = 0xa0; /* Only red moves; the black frame stays identical. */
  assert(quiet_dashboard_update(&s, &c, &m, entered + 1, &r) == ESP_OK && r.red_full);
  assert(full_calls == calls + 1 && s.red_checksum != old_checksum);
  assert(!ink(physical_red, 137, 100) && ink(physical_red, 138, 100));
  pet.image[41 * 48 + 17] = 0x80; /* BW change while red remains also needs full. */
  assert(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 1, &r) == ESP_OK && r.red_full);
  pet.has_red = false;
  assert(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 1, &r) == ESP_OK && r.red_full);
  assert(!s.previous_has_red); white_red();
  const int64_t left = s.last_full_ms;
  const unsigned full_before = full_calls, quiet_before = partial_calls;
  pet.has_red = true;
  assert(quiet_dashboard_update(&s, &c, &m, left - 1, &r) == ESP_OK && !r.full && r.changed);
  assert(!s.previous_has_red && s.last_full_ms == left); white_red();
  assert(ink(physical, 138, 100) && partial_calls == quiet_before + 1 && full_calls == full_before);
  assert(quiet_dashboard_update(&s, &c, &m, left + 1, &r) == ESP_OK && !r.changed);
  assert(quiet_dashboard_update(&s, &c, &m, left + 119999, &r) == ESP_OK && !r.changed);
  assert(s.last_full_ms == left);
  /* Cooldown alone never schedules a new drive while the host retains this ID. */
  display_sync_policy_t p = {0}; display_sync_record_attempt(&p, left + 1, &m, true);
  assert(display_sync_evaluate(&p, left + 120000, &m) == DISPLAY_SYNC_NONE);
  assert(quiet_dashboard_update(&s, &c, &m, left + 120000, &r) == ESP_OK && r.red_full);
  assert(s.previous_has_red && ink(physical_red, 138, 100));
  /* Leaving for the work screen clears red even inside the new cooldown. */
  m.ambient = NULL; m.ambient_id[0] = 0;
  assert(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 1, &r) == ESP_OK && r.red_full);
  white_red();
  m.agents[0].weekly_percent++;
  assert(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 1, &r) == ESP_OK && !r.full && r.changed);
  /* Inverted entry during cooldown folds red into white foreground ink. */
  m.ambient = &pet; m.display.inverted = true;
  assert(quiet_dashboard_update(&s, &c, &m, s.last_full_ms + 2, &r) == ESP_OK && !r.full);
  assert(!ink(physical, 138, 100) && ink(physical, 139, 100)); white_red();
  /* All-zero or fully black-overlapped rectangles carry no actual red pigment. */
  s = (quiet_dashboard_t){0}; m.display.inverted = false;
  pet.has_red = false;
  assert(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full);
  pet.has_red = true; memset(pet.red, 0, sizeof(pet.red));
  assert(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && !r.changed);
  pet.red[0] = 0x80;
  assert(quiet_dashboard_update(&s, &c, &m, 2, &r) == ESP_OK && !r.changed);
  assert(!s.previous_has_red && !s.has_runtime_full); white_red();
  /* Startup can display red without consuming a runtime cooldown. */
  s = (quiet_dashboard_t){0}; pet.red[0] = 0xc0;
  assert(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK && r.full && !r.red_full);
  assert(s.previous_has_red && !s.has_runtime_full);
  pet.has_red = false;
  assert(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_OK && r.red_full);
  assert(!s.previous_has_red && s.has_runtime_full); white_red();
}
static void failure_tests(void) {
  epd_canvas_t c = {black, red}; quiet_dashboard_result_t r;
  for (unsigned change = 0; change < 3; change++) {
    quiet_dashboard_t s = {0}; codepulse_ui_model_t m = model(0); m.ambient = &pet;
    pet.has_red = change != 0; pet.red[0] = 0xc0;
    assert(quiet_dashboard_update(&s, &c, &m, 0, &r) == ESP_OK);
    const quiet_dashboard_t before = s;
    if (change == 0) pet.has_red = true;
    else if (change == 1) pet.red[0] = 0xa0;
    else pet.has_red = false;
    const unsigned full_before = full_calls, quiet_before = partial_calls;
    fail_next = true;
    assert(quiet_dashboard_update(&s, &c, &m, 1, &r) == ESP_FAIL && r.red_full && s.faulted);
    assert(s.previous_has_red == before.previous_has_red && s.red_checksum == before.red_checksum);
    assert(s.last_full_ms == before.last_full_ms && s.has_runtime_full == before.has_runtime_full);
    assert(!memcmp(s.previous, before.previous, sizeof(s.previous)));
    assert(!memcmp(s.previous, physical, sizeof(physical)));
    assert(quiet_dashboard_update(&s, &c, &m, 999999, &r) == ESP_ERR_INVALID_STATE);
    assert(full_calls == full_before + 1 && partial_calls == quiet_before);
  }
}
int main(void) {
  render_tests(); cooldown_fold_tests(); refresh_tests(); failure_tests();
  puts("PASS: red coordinates/MSB stride, black priority, inverted red; runtime full entry/replacement/exit, real red payload, 120s completion boundary, normal/inverted foreground cooldown folding, unchanged frames, held-card pacing and three full-failure latches");
  return 0;
}
