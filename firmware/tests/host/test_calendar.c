#include "codepulse_protocol.h"
#include "cJSON.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "calendar_fixture.h"

static codepulse_remote_status_t remote;
static unsigned cases, valid;
static cJSON *fixture(void) {
  cJSON *root = cJSON_Parse(calendar_fixture_json); assert(root); return root;
}
static cJSON *ambient(cJSON *root) { return cJSON_GetObjectItemCaseSensitive(root, "ambient"); }
static cJSON *calendar(cJSON *root) { return cJSON_GetObjectItemCaseSensitive(ambient(root), "calendar"); }
static void check(cJSON *root, bool accepted) {
  char *json = cJSON_PrintUnformatted(root); assert(json);
  assert(codepulse_protocol_parse(json, strlen(json), &remote) == ESP_OK);
  assert(remote.valid && !strcmp(remote.ambient.id, "calendar:2026-10-30"));
  if (remote.ambient.layout != (accepted ? CODEPULSE_AMBIENT_LAYOUT_CALENDAR : CODEPULSE_AMBIENT_LAYOUT_LEGACY))
    fprintf(stderr, "Calendar parse case %u: expected %u, got layout %u\n", cases + 1, accepted, remote.ambient.layout);
  assert(remote.ambient.layout == (accepted ? CODEPULSE_AMBIENT_LAYOUT_CALENDAR : CODEPULSE_AMBIENT_LAYOUT_LEGACY));
  if (accepted) assert(!remote.ambient.has_image && !remote.ambient.has_red);
  else {
    const codepulse_calendar_t empty = {0};
    assert(!memcmp(&remote.ambient.calendar, &empty, sizeof(empty)));
    assert(remote.ambient.has_image == cJSON_IsString(cJSON_GetObjectItemCaseSensitive(ambient(root), "imageHex")));
  }
  codepulse_ui_model_t m = {0}; codepulse_remote_apply(&remote, &m);
  assert(m.ambient == &remote.ambient);
  cJSON_free(json); cJSON_Delete(root); cases++; valid += accepted;
}
static void replace(cJSON *object, const char *key, const char *json) {
  assert(cJSON_ReplaceItemInObjectCaseSensitive(object, key, cJSON_Parse(json)));
}
static void with_image(cJSON *root) {
  char image[CODEPULSE_AMBIENT_BYTES * 2 + 1];
  memset(image, '0', sizeof(image) - 1); image[sizeof(image) - 1] = 0;
  assert(cJSON_AddStringToObject(ambient(root), "imageHex", image));
  assert(cJSON_AddItemToObject(ambient(root), "red", cJSON_Parse("{\"x\":0,\"y\":0,\"w\":8,\"h\":1,\"hex\":\"80\"}")));
}
int main(void) {
  check(fixture(), true);
  assert(remote.ambient.calendar.year == 2026 && remote.ambient.calendar.month == 10 && remote.ambient.calendar.today == 30);
  assert(!strcmp(remote.ambient.calendar.labels[0], "国庆节") && remote.ambient.calendar.flags[0] == 7);
  assert(!strcmp(remote.ambient.calendar.lunar, "丙午年 九月廿一") && remote.ambient.calendar.week == 44);
  const char *keys[] = {"year", "month", "today", "first", "days", "week", "lunar", "labels", "flags"};
  const char *types[] = {"null", "false", "{}", "[]", "\"x\"", "7"};
  for (unsigned image = 0; image < 2; image++) for (unsigned key = 0; key < 9; key++) {
    cJSON *root = fixture(); if (image) with_image(root);
    cJSON_DeleteItemFromObjectCaseSensitive(calendar(root), keys[key]); check(root, false);
    for (unsigned type = 0; type < 6; type++) {
      if (key < 6 && type == 5) continue;
      root = fixture(); if (image) with_image(root);
      replace(calendar(root), keys[key], types[type]); check(root, key == 6 && type == 4);
    }
  }
  const int lows[] = {1900,1,0,0,28,1}, highs[] = {2100,12,31,6,31,53};
  for (unsigned type = 0; type < 6; type++) { cJSON *root = fixture(); replace(ambient(root), "calendar", types[type]); check(root, false); }
  cJSON *missing = fixture(); cJSON_DeleteItemFromObjectCaseSensitive(ambient(missing), "calendar"); check(missing, false);
  for (unsigned field = 0; field < 6; field++) for (unsigned bound = 0; bound < 3; bound++) {
    cJSON *root = fixture(); char number[24];
    if (bound < 2) snprintf(number, sizeof(number), "%d", bound ? highs[field] + 1 : lows[field] - 1);
    else snprintf(number, sizeof(number), "%d.5", lows[field]);
    replace(calendar(root), keys[field], number); check(root, false);
  }
  for (unsigned length = 30; length <= 32; length += 2) for (unsigned field = 7; field < 9; field++) {
    cJSON *root = fixture(), *a = cJSON_GetObjectItemCaseSensitive(calendar(root), keys[field]);
    if (length == 30) cJSON_DeleteItemFromArray(a, 30);
    else assert(cJSON_AddItemToArray(a, field == 7 ? cJSON_CreateString("初一") : cJSON_CreateNumber(0)));
    check(root, false);
  }
  const char *bad_labels[] = {"null", "7", "{}", "true", "\"五个字超长\"", "\"abcdefghijklmnopq\"", "\"x\\ny\""};
  for (unsigned i = 0; i < sizeof(bad_labels)/sizeof(bad_labels[0]); i++) {
    cJSON *root = fixture();
    assert(cJSON_ReplaceItemInArray(cJSON_GetObjectItemCaseSensitive(calendar(root), "labels"), 0, cJSON_Parse(bad_labels[i])));
    check(root, false);
  }
  const char *good_labels[] = {"\"\"", "\"AB!?\"", "\"农历标签\"", "\"\\ud83c\\udf15\\ud83c\\udf15\\ud83c\\udf15\\ud83c\\udf15\""};
  for (unsigned i = 0; i < sizeof(good_labels)/sizeof(good_labels[0]); i++) {
    cJSON *root = fixture();
    assert(cJSON_ReplaceItemInArray(cJSON_GetObjectItemCaseSensitive(calendar(root), "labels"), 0, cJSON_Parse(good_labels[i])));
    check(root, true);
  }
  for (unsigned field = 0; field < 2; field++) {
    cJSON *root = fixture(); char bad_utf8[] = {(char)0xc0,(char)0xaf,0};
    if (field) assert(cJSON_ReplaceItemInObjectCaseSensitive(calendar(root), "lunar", cJSON_CreateString(bad_utf8)));
    else assert(cJSON_ReplaceItemInArray(cJSON_GetObjectItemCaseSensitive(calendar(root), "labels"), 0, cJSON_CreateString(bad_utf8)));
    check(root, false);
  }
  for (unsigned flag = 0; flag < 16; flag++) {
    cJSON *root = fixture();
    assert(cJSON_ReplaceItemInArray(cJSON_GetObjectItemCaseSensitive(calendar(root), "flags"), 0, cJSON_CreateNumber(flag)));
    check(root, (flag & 12) != 12);
  }
  const char *bad_flags[] = {"-1", "16", "1.5", "null", "true", "\"1\"", "{}", "[]"};
  for (unsigned i = 0; i < sizeof(bad_flags)/sizeof(bad_flags[0]); i++) {
    cJSON *root = fixture(); assert(cJSON_ReplaceItemInArray(cJSON_GetObjectItemCaseSensitive(calendar(root), "flags"), 0, cJSON_Parse(bad_flags[i]))); check(root, false);
  }
  for (unsigned len = 32; len < 34; len++) {
    cJSON *root = fixture(); char lunar[34]; memset(lunar, 'A', len); lunar[len] = 0;
    assert(cJSON_ReplaceItemInObjectCaseSensitive(calendar(root), "lunar", cJSON_CreateString(lunar))); check(root, len == 32);
  }
  for (unsigned year = 1900; year <= 2100; year += 100) {
    cJSON *root = fixture(), *c = calendar(root); unsigned days = year == 2000 ? 29 : 28;
    assert(cJSON_ReplaceItemInObjectCaseSensitive(c, "year", cJSON_CreateNumber(year)));
    replace(c, "month", "2"); assert(cJSON_ReplaceItemInObjectCaseSensitive(c, "days", cJSON_CreateNumber(days)));
    replace(c, "today", "0");
    cJSON *labels = cJSON_GetObjectItemCaseSensitive(c, "labels"), *flags = cJSON_GetObjectItemCaseSensitive(c, "flags");
    while (cJSON_GetArraySize(labels) > (int)days) { cJSON_DeleteItemFromArray(labels, (int)days); cJSON_DeleteItemFromArray(flags, (int)days); }
    cJSON *bad_today = cJSON_Duplicate(root, true); assert(bad_today);
    assert(cJSON_ReplaceItemInObjectCaseSensitive(calendar(bad_today), "today", cJSON_CreateNumber(days + 1)));
    check(root, true);
    check(bad_today, false); /* Within 0..31, but outside this February. */
  }
  cJSON *root = fixture(); replace(calendar(root), "days", "30"); check(root, false);
  root = fixture(); replace(calendar(root), "month", "2"); replace(calendar(root), "days", "28"); check(root, false);
  root = fixture(); with_image(root); check(root, true);
  root = fixture(); with_image(root); replace(ambient(root), "imageHex", "\"zz\""); check(root, true);
  root = fixture(); with_image(root); replace(calendar(root), "year", "0"); check(root, false); assert(remote.ambient.has_red);
  const char *layouts[] = {"null", "\"future\"", "7", "{}"};
  for (unsigned i = 0; i < 4; i++) { root = fixture(); replace(ambient(root), "layout", layouts[i]); check(root, false); }
  root = fixture(); cJSON_DeleteItemFromObjectCaseSensitive(ambient(root), "layout"); check(root, false);
  printf("PASS: %u calendar parse cases (%u valid), strict ranges/UTF-8/lengths/flags, leap centuries, stale clearing and image-priority/fallback\n", cases, valid);
  return 0;
}
