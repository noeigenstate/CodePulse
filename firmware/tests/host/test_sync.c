#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "codepulse_protocol.h"
#include "display_sync_policy.h"
#include "cJSON.h"

static codepulse_remote_status_t parse_agent(const char *agent) {
  char json[2048];
  snprintf(json, sizeof(json),
           "{\"protocolVersion\":1,\"revision\":\"v1-test\","
           "\"mainState\":\"idle\",\"agents\":[%s]}",
           agent);
  codepulse_remote_status_t status;
  codepulse_remote_status_reset(&status);
  assert(codepulse_protocol_parse(json, strlen(json), &status) == ESP_OK);
  assert(status.valid);
  return status;
}

static codepulse_ui_model_t baseline_model(void) {
  codepulse_ui_model_t model = {
      .environment_valid = true,
      .temperature_c = 30.0f,
      .humidity_rh = 50.0f,
      .battery_valid = true,
      .battery_percent = 75,
      .wifi_connected = true,
      .agent_count = CODEPULSE_UI_MAX_AGENTS,
      .agents =
          {
              {.type = CODEPULSE_UI_AGENT_CLAUDE,
               .state = CODEPULSE_UI_AGENT_OFFLINE,
               .five_hour_percent = -1,
               .weekly_percent = -1},
              {.type = CODEPULSE_UI_AGENT_CODEX,
               .state = CODEPULSE_UI_AGENT_RUNNING,
               .five_hour_percent = -1,
               .weekly_percent = 1},
              {.type = CODEPULSE_UI_AGENT_GROK,
               .state = CODEPULSE_UI_AGENT_OFFLINE,
               .five_hour_percent = -1,
               .weekly_percent = -1},
          },
  };
  return model;
}

static display_sync_policy_t shown_policy(const codepulse_ui_model_t *model) {
  display_sync_policy_t policy = {0};
  display_sync_record_attempt(&policy, 0, model, true);
  return policy;
}

static void test_refresh_policy(void) {
  codepulse_ui_model_t model = baseline_model();
  display_sync_policy_t policy = shown_policy(&model);
  // Small sensor and ADC fluctuations alone never start a waveform.
  model.temperature_c = 30.4f;
  model.humidity_rh = 52.0f;
  model.battery_percent = 78;
  assert(display_sync_evaluate(&policy, 180000, &model) == DISPLAY_SYNC_NONE);
  assert(display_sync_evaluate(&policy, 3600000, &model) == DISPLAY_SYNC_NONE);

  // Compare cumulative drift with the last successful screen, not the last
  // poll.
  model.temperature_c = 31.0f;
  assert(display_sync_evaluate(&policy, 899999, &model) == DISPLAY_SYNC_NONE);
  assert(display_sync_evaluate(&policy, 900000, &model) ==
         DISPLAY_SYNC_ENVIRONMENT);
  display_sync_record_attempt(&policy, 900000, &model, true);
  assert(display_sync_evaluate(&policy, 1800000, &model) == DISPLAY_SYNC_NONE);
  model.humidity_rh = 57.0f;
  assert(display_sync_evaluate(&policy, 1800000, &model) ==
         DISPLAY_SYNC_ENVIRONMENT);

  model = baseline_model();
  policy = shown_policy(&model);
  model.battery_percent = 65;
  assert(display_sync_evaluate(&policy, 899999, &model) == DISPLAY_SYNC_NONE);
  assert(display_sync_evaluate(&policy, 900000, &model) ==
         DISPLAY_SYNC_BATTERY);

  // Important states bypass all previous interval/settle gates, even 1ms
  // after the preceding successful waveform. Ordinary transitions do too.
  const codepulse_ui_agent_state_t important[] = {CODEPULSE_UI_AGENT_WAITING,
    CODEPULSE_UI_AGENT_DONE, CODEPULSE_UI_AGENT_ERROR, CODEPULSE_UI_AGENT_LIMITED};
  for (size_t i = 0; i < sizeof(important)/sizeof(important[0]); i++) {
    model = baseline_model(); policy = shown_policy(&model);
    model.agents[1].state = important[i];
    assert(display_sync_evaluate(&policy, 1, &model) == DISPLAY_SYNC_ATTENTION);
    codepulse_ui_model_t target;
    display_sync_project(&policy, 1, &model, false, &target);
    assert(target.agents[1].state == important[i]);
    display_sync_record_attempt(&policy, 2, &target, true);
    assert(display_sync_evaluate(&policy, 3, &model) == DISPLAY_SYNC_NONE);
    model.agents[1].state = CODEPULSE_UI_AGENT_RUNNING;
    assert(display_sync_evaluate(&policy, 4, &model) == DISPLAY_SYNC_AGENT_STATE);
  }
  // Changing unrelated activity cannot defer an important state.
  model.agents[0].state = CODEPULSE_UI_AGENT_RUNNING;
  model.agents[1].state = CODEPULSE_UI_AGENT_DONE;
  assert(display_sync_evaluate(&policy, 5, &model) == DISPLAY_SYNC_ATTENTION);

  model = baseline_model(); policy = shown_policy(&model);
  model.agents[1].five_hour_percent = 20; // hidden Codex 5h
  assert(display_sync_evaluate(&policy, 1, &model) == DISPLAY_SYNC_NONE);
  model.agents[0].five_hour_percent = 0;
  assert(display_sync_evaluate(&policy, 2, &model) == DISPLAY_SYNC_QUOTA);
  display_sync_record_attempt(&policy, 2, &model, true);
  model.agents[1].weekly_percent = 2;
  assert(display_sync_evaluate(&policy, 3, &model) == DISPLAY_SYNC_QUOTA);
  display_sync_record_attempt(&policy, 3, &model, true);
  model.agents[1].weekly_percent = -1;
  assert(display_sync_evaluate(&policy, 4, &model) == DISPLAY_SYNC_QUOTA);

  // Failed optical baseline never advances or automatically retries.
  const int shown_quota = policy.displayed.agents[1].weekly_percent;
  display_sync_record_attempt(&policy, 4, &model, false);
  assert(policy.displayed.agents[1].weekly_percent == shown_quota);
  assert(display_sync_evaluate(&policy, 5, &model) == DISPLAY_SYNC_NONE);
  assert(display_sync_evaluate(&policy, 9999999, &model) == DISPLAY_SYNC_NONE);
  model = baseline_model(); policy = shown_policy(&model);
  display_sync_record_attempt(&policy, 10, &model, true);
  assert(display_sync_evaluate(&policy, 9, &model) == DISPLAY_SYNC_NONE);

  model = baseline_model(); policy = shown_policy(&model);
  model.wifi_connected = false;
  assert(display_sync_evaluate(&policy, 1, &model) == DISPLAY_SYNC_NONE);
  assert(display_sync_evaluate(&policy, 3001, &model) == DISPLAY_SYNC_CONNECTIVITY);
  model.wifi_connected = true;
  assert(display_sync_evaluate(&policy, 3002, &model) == DISPLAY_SYNC_NONE);

  // Array ordering carries no display meaning; UI uses provider identity.
  codepulse_ui_agent_t swapped = model.agents[0];
  model.agents[0] = model.agents[1];
  model.agents[1] = swapped;
  assert(display_sync_evaluate(&policy, 900000, &model) == DISPLAY_SYNC_NONE);
  // A manual refresh accepts the latest sensors and quotas in one operation.
  model.temperature_c = 32.0f;
  display_sync_record_attempt(&policy, 900000, &model, true);
  assert(display_sync_evaluate(&policy, 1800000, &model) == DISPLAY_SYNC_NONE);
}

static void test_display_extension(void) {
  const char *prefix="{\"protocolVersion\":1,\"revision\":\"display-test\",\"mainState\":\"running\",\"agents\":[],\"display\":{\"version\":1,\"mode\":\"hud\",\"metric\":\"remaining\",\"showQuota\":true,\"showEnvironment\":true,\"agents\":[\"codex\"],\"page\":0},\"threadTotal\":9,\"threads\":[";
  char json[8192];snprintf(json,sizeof(json),"%s",prefix);
  for(int i=0;i<9;i++) {
    char row[512];snprintf(row,sizeof(row),"%s{\"id\":\"id%d\",\"type\":\"codex\",\"title\":\"中文项目 %d\",\"detail\":\"等待确认\",\"state\":\"waiting_permission\"}",i?",":"",i,i);
    strcat(json,row);
  }
  strcat(json,"]}");codepulse_remote_status_t parsed={0};
  assert(codepulse_protocol_parse(json,strlen(json),&parsed)==ESP_OK);
  assert(parsed.display.valid && parsed.display.hud && parsed.display.remaining && parsed.thread_count==9);
  assert(parsed.threads[8].state==CODEPULSE_UI_AGENT_WAITING);
  assert(!strcmp(parsed.threads[8].title,"中文项目 8"));
  codepulse_remote_status_t before=parsed;
  char *id=strstr(json,"id8");assert(id);id[2]='0';
  assert(codepulse_protocol_parse(json,strlen(json),&parsed)==ESP_ERR_INVALID_RESPONSE);
  assert(!memcmp(&before,&parsed,sizeof(parsed)));id[2]='8';
  char *version=strstr(json,"\"version\":1");assert(version);version[10]='2';
  assert(codepulse_protocol_parse(json,strlen(json),&parsed)==ESP_ERR_INVALID_RESPONSE);
  version[10]='1';
  json[strlen(json)-2]=',';json[strlen(json)-1]='\0';
  strcat(json,"{\"id\":\"tenth\",\"type\":\"codex\",\"title\":\"overflow\",\"detail\":\"\",\"state\":\"thinking\"}]}");
  assert(codepulse_protocol_parse(json,strlen(json),&parsed)==ESP_ERR_INVALID_RESPONSE);
  assert(!memcmp(&before,&parsed,sizeof(parsed)));
}

static void test_ambient_extension(void) {
  const char *json = "{\"protocolVersion\":1,\"revision\":\"desk1\",\"mainState\":\"idle\",\"agents\":[],\"ambient\":{\"id\":\"news1\",\"source\":\"@Polymarket\",\"text\":\"A public post\"}}";
  codepulse_remote_status_t remote;
  assert(codepulse_protocol_parse(json, strlen(json), &remote) == ESP_OK);
  codepulse_ui_model_t model = {0};
  codepulse_remote_apply(&remote, &model);
  assert(model.ambient && !strcmp(model.ambient_id, "news1"));
  assert(!strcmp(model.ambient->source, "@Polymarket"));
  display_sync_policy_t policy = {0};
  display_sync_record_attempt(&policy, 1000, &model, true);
  snprintf(remote.ambient.id, sizeof(remote.ambient.id), "news2");
  codepulse_remote_apply(&remote, &model);
  assert(!strcmp(policy.displayed.ambient_id, "news1"));
  assert(display_sync_evaluate(&policy, 1001, &model) == DISPLAY_SYNC_LAYOUT);
  remote.agents[0].state = CODEPULSE_UI_AGENT_WAITING;
  codepulse_remote_apply(&remote, &model);
  assert(!model.ambient && !model.ambient_id[0]);
  assert(display_sync_evaluate(&policy, 1002, &model) == DISPLAY_SYNC_LAYOUT);
  const codepulse_remote_status_t before = remote;
  const char *bad = "{\"protocolVersion\":1,\"revision\":\"desk2\",\"mainState\":\"idle\",\"agents\":[],\"ambient\":{\"id\":\"news1\",\"source\":\"x\",\"text\":\"x\",\"imageHex\":\"zz\"}}";
  assert(codepulse_protocol_parse(bad, strlen(bad), &remote) == ESP_ERR_INVALID_RESPONSE);
  assert(!memcmp(&before, &remote, sizeof(remote)));
}


static void test_manual_ambient(void) {
  const char *json = "{\"protocolVersion\":1,\"revision\":\"manual1\",\"mainState\":\"done\",\"agents\":[],\"ambient\":{\"id\":\"picture\",\"source\":\"local\",\"text\":\"caption\",\"manual\":true}}";
  codepulse_remote_status_t remote;
  assert(codepulse_protocol_parse(json, strlen(json), &remote) == ESP_OK);
  assert(remote.ambient.manual);
  codepulse_ui_model_t model = {0};
  codepulse_remote_apply(&remote, &model);
  assert(model.ambient);
  remote.thread_count = 1;
  remote.threads[0].level = CODEPULSE_LEVEL_NOTICE;
  codepulse_remote_apply(&remote, &model);
  assert(model.ambient);
  remote.ambient.manual = false;
  codepulse_remote_apply(&remote, &model);
  assert(!model.ambient);
  remote.ambient.manual = true;
  for (int level = CODEPULSE_LEVEL_ACTION; level <= CODEPULSE_LEVEL_FAULT; level++) {
    remote.threads[0].level = level;
    codepulse_remote_apply(&remote, &model);
    assert(!model.ambient);
  }
  const codepulse_remote_status_t before = remote;
  const char *bad = "{\"protocolVersion\":1,\"revision\":\"manual2\",\"mainState\":\"idle\",\"agents\":[],\"ambient\":{\"id\":\"picture\",\"source\":\"local\",\"text\":\"caption\",\"manual\":\"true\"}}";
  assert(codepulse_protocol_parse(bad, strlen(bad), &remote) == ESP_ERR_INVALID_RESPONSE);
  assert(!memcmp(&before, &remote, sizeof(remote)));
}

static unsigned red_cases, red_valid_cases;
static codepulse_remote_status_t red_remote;
static cJSON *pet_json(void) {
  cJSON *root = cJSON_Parse("{\"protocolVersion\":1,\"revision\":\"pet-test\",\"mainState\":\"idle\",\"agents\":[],"
      "\"ambient\":{\"id\":\"pet:cat:calm:2026-10-29\",\"source\":\"local\",\"text\":\"pet card\","
      "\"red\":{\"x\":128,\"y\":40,\"w\":16,\"h\":2,\"hex\":\"80aAfF01\"}}}");
  assert(root);
  char image[CODEPULSE_AMBIENT_BYTES * 2 + 1];
  memset(image, '0', sizeof(image) - 1); image[0] = '8'; image[sizeof(image) - 1] = 0;
  assert(cJSON_AddStringToObject(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "imageHex", image));
  return root;
}
static void test_ambient_layout(void) {
  const char *values[] = {"\"pet\"", NULL, "null", "\"future\"", "\"PET\"", "\"\"",
                          "\"pet \"", "42", "{}", "[]", "true", "false"};
  codepulse_remote_status_t remote;
  unsigned cases = 0;
  for (unsigned image = 0; image < 3; image++)
    for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
      cJSON *root = pet_json(), *a = cJSON_GetObjectItemCaseSensitive(root, "ambient");
      if (values[i]) assert(cJSON_AddItemToObject(a, "layout", cJSON_Parse(values[i])));
      if (image == 1) cJSON_DeleteItemFromObjectCaseSensitive(a, "imageHex");
      if (image == 2) assert(cJSON_ReplaceItemInObjectCaseSensitive(a, "imageHex", cJSON_CreateNull()));
      char *json = cJSON_PrintUnformatted(root); assert(json);
      assert(codepulse_protocol_parse(json, strlen(json), &remote) == ESP_OK);
      assert(remote.valid && !strcmp(remote.ambient.text, "pet card"));
      assert(remote.ambient.has_image == (image == 0));
      assert(remote.ambient.has_red == (image == 0));
      assert(remote.ambient.layout == (image == 0 && i == 0 ?
             CODEPULSE_AMBIENT_LAYOUT_PET : CODEPULSE_AMBIENT_LAYOUT_LEGACY));
      codepulse_ui_model_t m = {0}; codepulse_remote_apply(&remote, &m);
      assert(m.ambient == &remote.ambient && m.ambient->layout == remote.ambient.layout);
      cJSON_free(json); cJSON_Delete(root); cases++;
    }
  const codepulse_remote_status_t before = remote;
  cJSON *root = pet_json(), *a = cJSON_GetObjectItemCaseSensitive(root, "ambient");
  assert(cJSON_AddStringToObject(a, "layout", "pet"));
  assert(cJSON_ReplaceItemInObjectCaseSensitive(a, "imageHex", cJSON_CreateString("zz")));
  char *json = cJSON_PrintUnformatted(root); assert(json);
  assert(codepulse_protocol_parse(json, strlen(json), &remote) == ESP_ERR_INVALID_RESPONSE);
  assert(!memcmp(&remote, &before, sizeof(remote)));
  cJSON_free(json); cJSON_Delete(root);
  printf("PASS: %u layout parse cases, stale layout cleared, invalid image remains strict\n", cases);
}
static void check_red(cJSON *root, bool accepted) {
  char *json = cJSON_PrintUnformatted(root); assert(json);
  assert(strlen(json) < 32000);
  assert(codepulse_protocol_parse(json, strlen(json), &red_remote) == ESP_OK);
  cJSON_free(json);
  assert(red_remote.valid && !strcmp(red_remote.revision, "pet-test"));
  assert(!strcmp(red_remote.ambient.id, "pet:cat:calm:2026-10-29"));
  assert(!strcmp(red_remote.ambient.source, "local") && !strcmp(red_remote.ambient.text, "pet card"));
  const cJSON *image = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "imageHex");
  assert(red_remote.ambient.has_image == cJSON_IsString(image));
  if (red_remote.ambient.has_image) assert(red_remote.ambient.image[0] == 0x80);
  assert(red_remote.ambient.has_red == accepted);
  if (!accepted) {
    assert(!red_remote.ambient.red_x && !red_remote.ambient.red_y && !red_remote.ambient.red_w && !red_remote.ambient.red_h);
    for (size_t i = 0; i < sizeof(red_remote.ambient.red); i++) assert(!red_remote.ambient.red[i]);
  }
  codepulse_ui_model_t m = {0}; codepulse_remote_apply(&red_remote, &m);
  assert(m.ambient == &red_remote.ambient && !strcmp(m.ambient_id, red_remote.ambient.id));
  red_cases++; if (accepted) red_valid_cases++;
  cJSON_Delete(root);
}
static void test_red_ambient(void) {
  cJSON *root = pet_json(); check_red(root, true);
  assert(red_remote.ambient.red_x == 128 && red_remote.ambient.red_y == 40 &&
         red_remote.ambient.red_w == 16 && red_remote.ambient.red_h == 2);
  const uint8_t expected[] = {0x80, 0xaa, 0xff, 0x01};
  assert(!memcmp(red_remote.ambient.red, expected, sizeof(expected)));
  /* Missing optional data and wrong JSON types leave the whole status usable. */
  const char *types[] = {"null", "false", "true", "1", "\"red\"", "[]", "{}"};
  for (size_t i = 0; i < sizeof(types) / sizeof(types[0]); i++) {
    root = pet_json(); cJSON *a = cJSON_GetObjectItemCaseSensitive(root, "ambient");
    assert(cJSON_ReplaceItemInObjectCaseSensitive(a, "red", cJSON_Parse(types[i])));
    check_red(root, false);
  }
  root = pet_json(); cJSON_DeleteItemFromObjectCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "red");
  check_red(root, false);
  const char *keys[] = {"x", "y", "w", "h", "hex"};
  for (unsigned field = 0; field < 5; field++) {
    root = pet_json(); cJSON *r = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "red");
    cJSON_DeleteItemFromObjectCaseSensitive(r, keys[field]); check_red(root, false);
    for (unsigned type = 0; type < 5; type++) {
      root = pet_json(); r = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "red");
      const char *bad[] = {"null", "false", "\"0\"", "[]", "{}"};
      if (field == 4 && type == 2) {
        assert(cJSON_ReplaceItemInObjectCaseSensitive(r, keys[field], cJSON_CreateNumber(80)));
      } else assert(cJSON_ReplaceItemInObjectCaseSensitive(r, keys[field], cJSON_Parse(bad[type])));
      check_red(root, false);
    }
  }
  const double rectangles[][4] = {
    {-8,0,8,1}, {0,-1,8,1}, {384,0,8,1}, {376,0,16,1}, {0,208,8,1},
    {0,207,8,2}, {1,0,8,1}, {0,0,9,1}, {0,0,0,1}, {0,0,8,0},
    {0,0,-8,1}, {0,0,8,-1}, {0.5,0,8,1}, {0,0.5,8,1},
    {0,0,8.5,1}, {0,0,8,1.5}, {1e20,0,8,1}, {0,0,384,209}
  };
  for (size_t i = 0; i < sizeof(rectangles) / sizeof(rectangles[0]); i++) {
    root = pet_json(); cJSON *r = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "red");
    for (unsigned field = 0; field < 4; field++)
      assert(cJSON_ReplaceItemInObjectCaseSensitive(r, keys[field], cJSON_CreateNumber(rectangles[i][field])));
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r, "hex", cJSON_CreateString(i == 5 ? "8080" : "80")));
    check_red(root, false);
  }
  const char *bad_hex[] = {"", "8", "80aaFF0", "80aaFF0100", "80aaFF0g", "80aaFF0 "};
  for (size_t i = 0; i < sizeof(bad_hex) / sizeof(bad_hex[0]); i++) {
    root = pet_json(); cJSON *r = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "red");
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r, "hex", cJSON_CreateString(bad_hex[i])));
    check_red(root, false);
  }
  char max_hex[384 * 65 / 4 + 1]; memset(max_hex, 'f', sizeof(max_hex) - 1); max_hex[sizeof(max_hex) - 1] = 0;
  root = pet_json(); cJSON *a = cJSON_GetObjectItemCaseSensitive(root, "ambient"); cJSON *r = cJSON_GetObjectItemCaseSensitive(a, "red");
  const unsigned too_large[] = {0, 0, 384, 65};
  for (unsigned field = 0; field < 4; field++)
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r, keys[field], cJSON_CreateNumber(too_large[field])));
  assert(cJSON_ReplaceItemInObjectCaseSensitive(r, "hex", cJSON_CreateString(max_hex)));
  check_red(root, false); /* Correct hex length, but 3120 > 3072 bytes. */
  root = pet_json(); r = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "red");
  const unsigned largest[] = {0, 144, 384, 64}; max_hex[6144] = 0;
  for (unsigned field = 0; field < 4; field++)
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r, keys[field], cJSON_CreateNumber(largest[field])));
  assert(cJSON_ReplaceItemInObjectCaseSensitive(r, "hex", cJSON_CreateString(max_hex)));
  check_red(root, true);
  assert(red_remote.ambient.red[3071] == 255);
  root = pet_json(); r = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(root, "ambient"), "red");
  const unsigned edge[] = {376, 207, 8, 1};
  for (unsigned field = 0; field < 4; field++)
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r, keys[field], cJSON_CreateNumber(edge[field])));
  assert(cJSON_ReplaceItemInObjectCaseSensitive(r, "hex", cJSON_CreateString("80")));
  check_red(root, true);
  for (unsigned null_image = 0; null_image < 2; null_image++) {
    root = pet_json(); a = cJSON_GetObjectItemCaseSensitive(root, "ambient");
    if (null_image) assert(cJSON_ReplaceItemInObjectCaseSensitive(a, "imageHex", cJSON_CreateNull()));
    else cJSON_DeleteItemFromObjectCaseSensitive(a, "imageHex");
    check_red(root, false);
  }
  printf("PASS: %u red parse cases (%u valid, %u discarded); optional errors preserve status/card and clear stale red\n",
         red_cases, red_valid_cases, red_cases - red_valid_cases);
}

static void test_shared_quotas(void) {
  codepulse_remote_status_t r = parse_agent(
    "{\"type\":\"claude_code\",\"state\":\"idle\",\"quotas\":[{\"id\":\"claude\",\"fiveHour\":{\"usedPercent\":90},\"weekly\":{\"usedPercent\":95}}],"
    "\"quotaSummary\":{\"fiveHourUsedPercent\":27,\"weeklyUsedPercent\":61}}");
  assert(r.agents[0].five_hour_percent == 27 && r.agents[0].weekly_percent == 61);
  r = parse_agent(
    "{\"type\":\"claude_code\",\"state\":\"idle\",\"quotas\":[{\"id\":\"claude\",\"fiveHour\":{\"usedPercent\":90},\"weekly\":{\"usedPercent\":95}}],"
    "\"quotaSummary\":{\"fiveHourUsedPercent\":null,\"weeklyUsedPercent\":null}}");
  assert(r.agents[0].five_hour_percent == -1 && r.agents[0].weekly_percent == -1);
  r = parse_agent(
    "{\"type\":\"claude_code\",\"state\":\"idle\",\"quotas\":[{\"id\":\"claude\",\"fiveHour\":{\"usedPercent\":90},\"weekly\":{\"usedPercent\":95}}],"
    "\"quotaSummary\":{\"fiveHourUsedPercent\":27}}");
  assert(r.agents[0].five_hour_percent == 27 && r.agents[0].weekly_percent == 95);
  const char *invalid = "{\"protocolVersion\":1,\"revision\":\"bad\",\"mainState\":\"idle\",\"agents\":[{\"type\":\"codex\",\"state\":\"idle\",\"quotaSummary\":{\"weeklyUsedPercent\":\"bad\"}}]}";
  const codepulse_remote_status_t before = r;
  assert(codepulse_protocol_parse(invalid, strlen(invalid), &r) == ESP_ERR_INVALID_RESPONSE);
  assert(!memcmp(&before, &r, sizeof(r)));
}

static codepulse_remote_status_t presentation_thread(const char *state, const char *extra) {
  char json[2048];
  snprintf(json, sizeof(json), "{\"protocolVersion\":1,\"revision\":\"work\",\"mainState\":\"done\",\"agents\":[],"
    "\"display\":{\"version\":1,\"mode\":\"hud\",\"metric\":\"remaining\",\"showQuota\":true,\"showEnvironment\":true,\"agents\":[\"claude_code\",\"codex\"],\"page\":0},"
    "\"threadTotal\":1,\"threads\":[{\"id\":\"task1\",\"type\":\"codex\",\"title\":\"same task\",\"detail\":\"original detail\",\"state\":\"%s\"%s}]}", state, extra);
  codepulse_remote_status_t remote;
  assert(codepulse_protocol_parse(json, strlen(json), &remote) == ESP_OK);
  return remote;
}
static void test_work_presentation(void) {
  codepulse_remote_status_t remote = presentation_thread("done", ",\"level\":\"quiet\",\"unread\":false,\"groupId\":\"project1\"");
  assert(remote.thread_count == 1 && !strcmp(remote.threads[0].group_id, "project1"));
  assert(remote.threads[0].unread_known && !remote.threads[0].unread);
  assert(remote.threads[0].state == CODEPULSE_UI_AGENT_DONE);
  assert(codepulse_thread_level(&remote.threads[0]) == CODEPULSE_LEVEL_QUIET);
  codepulse_ui_model_t model = baseline_model();
  codepulse_remote_apply(&remote, &model);
  display_sync_policy_t policy = shown_policy(&model);
  /* The device never ages out idle/read cards on its own. */
  assert(display_sync_evaluate(&policy, 86400000, &model) == DISPLAY_SYNC_NONE);
  assert(model.thread_count == 1);
  model.threads[0].level = CODEPULSE_LEVEL_NOTICE;
  model.threads[0].unread = true;
  assert(display_sync_evaluate(&policy, 1, &model) == DISPLAY_SYNC_ATTENTION);
  display_sync_record_attempt(&policy, 2, &model, true);
  model.threads[0].level = CODEPULSE_LEVEL_QUIET;
  model.threads[0].unread = false;
  snprintf(model.threads[0].detail, sizeof(model.threads[0].detail), "read result");
  assert(display_sync_evaluate(&policy, 3, &model) == DISPLAY_SYNC_AGENT_STATE);
  codepulse_ui_model_t target;
  display_sync_project(&policy, 3, &model, false, &target);
  assert(!strcmp(target.threads[0].detail, "read result"));
  display_sync_record_attempt(&policy, 4, &model, true);
  model.agents[0].five_hour_percent = 27;
  assert(display_sync_evaluate(&policy, 5, &model) == DISPLAY_SYNC_QUOTA);
  model.display.show_quota = false;
  display_sync_record_attempt(&policy, 6, &model, true);
  model.agents[0].five_hour_percent = 28;
  assert(display_sync_evaluate(&policy, 7, &model) == DISPLAY_SYNC_NONE);
  model.threads[0].state = CODEPULSE_UI_AGENT_WAITING;
  model.threads[0].level = CODEPULSE_LEVEL_ACTION;
  snprintf(model.threads[0].state_reason, sizeof(model.threads[0].state_reason), "waiting_permission");
  display_sync_record_attempt(&policy, 8, &model, true);
  snprintf(model.threads[0].state_reason, sizeof(model.threads[0].state_reason), "waiting_user_input");
  assert(display_sync_evaluate(&policy, 9, &model) == DISPLAY_SYNC_ATTENTION);
  remote = presentation_thread("done", "");
  assert(codepulse_thread_level(&remote.threads[0]) == CODEPULSE_LEVEL_NOTICE);
  remote = presentation_thread("done", ",\"level\":\"future\",\"unread\":false");
  assert(codepulse_thread_level(&remote.threads[0]) == CODEPULSE_LEVEL_QUIET);
  remote = presentation_thread("timeout", ",\"unread\":false");
  assert(codepulse_thread_level(&remote.threads[0]) == CODEPULSE_LEVEL_QUIET);
  /* Explicit host level wins even if older state/unread disagree. */
  remote = presentation_thread("done", ",\"level\":\"quiet\",\"unread\":true");
  assert(codepulse_thread_level(&remote.threads[0]) == CODEPULSE_LEVEL_QUIET);
  snprintf(remote.ambient.id, sizeof(remote.ambient.id), "quiet-news");
  codepulse_remote_apply(&remote, &model);
  assert(model.ambient != NULL);
  remote.threads[0].level = CODEPULSE_LEVEL_ACTION;
  codepulse_remote_apply(&remote, &model);
  assert(model.ambient == NULL);
}

int main(void) {
  codepulse_ui_model_t inverse = baseline_model();
  inverse.display.valid = true;
  display_sync_policy_t inverse_policy = shown_policy(&inverse);
  inverse.display.inverted = true;
  assert(display_sync_evaluate(&inverse_policy, 1, &inverse) == DISPLAY_SYNC_LAYOUT);
  test_shared_quotas();
  test_work_presentation();
  test_ambient_extension();
  test_manual_ambient();
  test_ambient_layout();
  test_red_ambient();
  test_display_extension();
  /* The shared LAN projection must not overwrite locally sampled telemetry. */
  codepulse_ui_model_t local = { .environment_valid = true, .temperature_c = 31.5f,
    .humidity_rh = 47, .battery_valid = true, .battery_percent = 72,
    .wifi_connected = true };
  codepulse_remote_status_t projection;
  codepulse_remote_status_reset(&projection);
  projection.valid = true;
  projection.agents[1].weekly_percent = 53;
  projection.display.valid = projection.display.hud = true;
  projection.display.agent_mask = 2;
  projection.thread_count = projection.thread_total = 1;
  snprintf(projection.threads[0].title, sizeof(projection.threads[0].title), "CodePulse");
  projection.weekly_resets[1] = 1793000000;
  codepulse_remote_apply(&projection, &local);
  assert(local.environment_valid && local.temperature_c == 31.5f && local.humidity_rh == 47);
  assert(local.battery_valid && local.battery_percent == 72 && local.wifi_connected);
  assert(local.agents[1].weekly_percent == 53 && local.agent_count == 3);
  assert(local.display.hud && local.display.agent_mask == 2 && local.thread_count == 1);
  assert(!strcmp(local.threads[0].title, "CodePulse") && local.weekly_resets[1] == 1793000000);
  const codepulse_ui_model_t unchanged = local;
  projection.valid = false;
  codepulse_remote_apply(&projection, &local);
  codepulse_remote_apply(NULL, &local);
  assert(!memcmp(&local, &unchanged, sizeof(local)));
  codepulse_remote_status_t status = parse_agent(
      "{\"type\":\"grok\",\"state\":\"idle\",\"project\":null,"
      "\"quotas\":[{\"id\":\"grok\",\"weekly\":{\"usedPercent\":18}}]}");
  assert(status.agents[2].state == CODEPULSE_UI_AGENT_OFFLINE);
  assert(status.agents[2].weekly_percent == 18);
  status = parse_agent(
      "{\"type\":\"grok\",\"state\":\"idle\",\"project\":\"demo\"}");
  assert(status.agents[2].state == CODEPULSE_UI_AGENT_IDLE);
  status = parse_agent("{\"type\":\"grok\",\"state\":\"idle\"}");
  assert(status.agents[2].state == CODEPULSE_UI_AGENT_IDLE);
  status = parse_agent(
      "{\"type\":\"codex\",\"state\":\"thinking\",\"project\":null}");
  assert(status.agents[1].state == CODEPULSE_UI_AGENT_RUNNING);
  status = parse_agent("{\"type\":\"codex\",\"state\":\"waiting_permission\","
                       "\"project\":\"demo\"}");
  assert(status.agents[1].state == CODEPULSE_UI_AGENT_WAITING);
  const codepulse_remote_status_t previous = status;
  assert(codepulse_protocol_parse("{}", 2, &status) ==
         ESP_ERR_INVALID_RESPONSE);
  assert(memcmp(&status, &previous, sizeof(status)) == 0);

  test_refresh_policy();
  puts("PASS: account/task mapping, protocol rejection, semantic refresh "
       "triggers, prompt attention, sensor suppression and fault latch");
  return 0;
}
