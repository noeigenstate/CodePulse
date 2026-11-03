#include "codepulse_protocol.h"

#include <ctype.h>
#include <limits.h>
#include <string.h>
#include <stdlib.h>

#include "cJSON.h"

#define CODEPULSE_JSON_SAFE_INTEGER_MAX 9007199254740991.0

static codepulse_remote_agent_t offline_agent(codepulse_ui_agent_type_t type) {
  return (codepulse_remote_agent_t){
      .type = type,
      .state = CODEPULSE_UI_AGENT_OFFLINE,
      .five_hour_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
      .weekly_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
  };
}

void codepulse_remote_status_reset(codepulse_remote_status_t *status) {
  if (status == NULL) {
    return;
  }
  memset(status, 0, sizeof(*status));
  status->agents[0] = offline_agent(CODEPULSE_UI_AGENT_CLAUDE);
  status->agents[1] = offline_agent(CODEPULSE_UI_AGENT_CODEX);
  status->agents[2] = offline_agent(CODEPULSE_UI_AGENT_GROK);
  status->agent_count = CODEPULSE_UI_MAX_AGENTS;
}

static codepulse_remote_agent_t *
agent_for_type(codepulse_remote_status_t *status,
               codepulse_ui_agent_type_t type) {
  for (size_t index = 0; index < status->agent_count; ++index) {
    if (status->agents[index].type == type) {
      return &status->agents[index];
    }
  }
  return NULL;
}

static bool parse_agent_type(const char *value,
                             codepulse_ui_agent_type_t *type) {
  if (strcmp(value, "claude_code") == 0) {
    *type = CODEPULSE_UI_AGENT_CLAUDE;
    return true;
  }
  if (strcmp(value, "codex") == 0) {
    *type = CODEPULSE_UI_AGENT_CODEX;
    return true;
  }
  if (strcmp(value, "grok") == 0) {
    *type = CODEPULSE_UI_AGENT_GROK;
    return true;
  }
  return false;
}

static codepulse_ui_agent_state_t parse_agent_state(const char *value) {
  if (strcmp(value, "idle") == 0 || strcmp(value, "cancelled") == 0) {
    return CODEPULSE_UI_AGENT_IDLE;
  }
  if (strcmp(value, "prompt_submitted") == 0 ||
      strcmp(value, "thinking") == 0 || strcmp(value, "tool_running") == 0) {
    return CODEPULSE_UI_AGENT_RUNNING;
  }
  if (strcmp(value, "waiting_permission") == 0 ||
      strcmp(value, "waiting_user_input") == 0) {
    return CODEPULSE_UI_AGENT_WAITING;
  }
  if (strcmp(value, "done") == 0) {
    return CODEPULSE_UI_AGENT_DONE;
  }
  if (strcmp(value, "error") == 0 || strcmp(value, "timeout") == 0) {
    return CODEPULSE_UI_AGENT_ERROR;
  }
  if (strcmp(value, "usage_limited") == 0) {
    return CODEPULSE_UI_AGENT_LIMITED;
  }
  return CODEPULSE_UI_AGENT_OFFLINE;
}

static int parse_percent(const cJSON *parent, const char *key) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(parent, key);
  if (!cJSON_IsNumber(value)) {
    return CODEPULSE_UI_PERCENT_UNKNOWN;
  }
  double percent = value->valuedouble;
  if (percent < 0.0) {
    percent = 0.0;
  } else if (percent > 100.0) {
    percent = 100.0;
  }
  return (int)(percent + 0.5);
}

static int quota_window_percent(const cJSON *quota, const char *key) {
  const cJSON *window = cJSON_GetObjectItemCaseSensitive(quota, key);
  if (!cJSON_IsObject(window)) {
    return CODEPULSE_UI_PERCENT_UNKNOWN;
  }
  return parse_percent(window, "usedPercent");
}

static bool contains_case_insensitive(const char *text, const char *needle) {
  if (text == NULL || needle == NULL || *needle == '\0') {
    return false;
  }
  const size_t needle_length = strlen(needle);
  for (const char *cursor = text; *cursor != '\0'; ++cursor) {
    size_t index = 0;
    while (index < needle_length && cursor[index] != '\0' &&
           tolower((unsigned char)cursor[index]) ==
               tolower((unsigned char)needle[index])) {
      ++index;
    }
    if (index == needle_length) {
      return true;
    }
  }
  return false;
}

static int quota_priority(const cJSON *quota,
                          codepulse_ui_agent_type_t agent_type,
                          const char *model) {
  const cJSON *id_value = cJSON_GetObjectItemCaseSensitive(quota, "id");
  const char *id = cJSON_IsString(id_value) ? id_value->valuestring : "";
  const bool model_is_spark = contains_case_insensitive(model, "spark");
  const bool quota_is_spark = contains_case_insensitive(id, "spark");

  int priority = 1;
  if (model_is_spark == quota_is_spark) {
    priority += 20;
  }
  if ((agent_type == CODEPULSE_UI_AGENT_CODEX && strcmp(id, "codex") == 0) ||
      (agent_type == CODEPULSE_UI_AGENT_CLAUDE &&
       (strcmp(id, "claude") == 0 || strcmp(id, "claude_code") == 0)) ||
      (agent_type == CODEPULSE_UI_AGENT_GROK && strcmp(id, "grok") == 0)) {
    priority += 10;
  }
  return priority;
}

static void parse_quotas(const cJSON *agent_object, const char *model,
                         codepulse_remote_agent_t *agent) {
  const cJSON *quotas =
      cJSON_GetObjectItemCaseSensitive(agent_object, "quotas");
  if (!cJSON_IsArray(quotas)) {
    return;
  }

  int best_priority = INT_MIN;
  const cJSON *quota = NULL;
  cJSON_ArrayForEach(quota, quotas) {
    if (!cJSON_IsObject(quota)) {
      continue;
    }
    const int five_hour = quota_window_percent(quota, "fiveHour");
    const int weekly = quota_window_percent(quota, "weekly");
    if (five_hour == CODEPULSE_UI_PERCENT_UNKNOWN &&
        weekly == CODEPULSE_UI_PERCENT_UNKNOWN) {
      continue;
    }
    const int priority = quota_priority(quota, agent->type, model);
    if (priority > best_priority) {
      best_priority = priority;
      agent->five_hour_percent = five_hour;
      agent->weekly_percent = weekly;
    }
  }
}

/* A present null is authoritative unknown; only missing fields use legacy quotas. */
static bool parse_quota_summary(const cJSON *object, codepulse_remote_agent_t *agent) {
  const cJSON *summary = cJSON_GetObjectItemCaseSensitive(object, "quotaSummary");
  if (!summary) return true;
  if (cJSON_IsNull(summary)) {
    agent->five_hour_percent = agent->weekly_percent = CODEPULSE_UI_PERCENT_UNKNOWN;
    return true;
  }
  if (!cJSON_IsObject(summary)) return false;
  const char *keys[] = {"fiveHourUsedPercent", "weeklyUsedPercent"};
  int *values[] = {&agent->five_hour_percent, &agent->weekly_percent};
  for (unsigned i = 0; i < 2; i++) {
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(summary, keys[i]);
    if (!value) continue;
    if (cJSON_IsNull(value)) *values[i] = CODEPULSE_UI_PERCENT_UNKNOWN;
    else if (cJSON_IsNumber(value) && value->valuedouble >= 0 && value->valuedouble <= 100)
      *values[i] = (int)(value->valuedouble + 0.5);
    else return false;
  }
  return true;
}

static void parse_tokens(const cJSON *agent_object,
                         codepulse_remote_agent_t *agent) {
  const cJSON *tokens =
      cJSON_GetObjectItemCaseSensitive(agent_object, "tokens");
  if (!cJSON_IsObject(tokens)) {
    return;
  }

  const cJSON *total = cJSON_GetObjectItemCaseSensitive(tokens, "total");
  if (cJSON_IsNumber(total)) {
    const double total_value = total->valuedouble;
    if (total_value >= 0.0 && total_value <= CODEPULSE_JSON_SAFE_INTEGER_MAX &&
        (double)(uint64_t)total_value == total_value) {
      agent->total_tokens_valid = true;
      agent->total_tokens = (uint64_t)total_value;
    }
  }

  const cJSON *context =
      cJSON_GetObjectItemCaseSensitive(tokens, "contextUsedPercent");
  if (cJSON_IsNumber(context)) {
    double percent = context->valuedouble;
    if (percent < 0.0) {
      percent = 0.0;
    } else if (percent > 100.0) {
      percent = 100.0;
    }
    agent->context_used_percent_valid = true;
    agent->context_used_percent = (float)percent;
  }
}

static bool copy_text(const cJSON *o,const char *key,char *out,size_t size) {
  const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,key);
  if(!cJSON_IsString(v) || !v->valuestring || strlen(v->valuestring)>=size)return false;
  memcpy(out,v->valuestring,strlen(v->valuestring)+1);return true;
}
static bool parse_thread_presentation(const cJSON *item, codepulse_ui_thread_t *t) {
  const cJSON *level = cJSON_GetObjectItemCaseSensitive(item, "level");
  const cJSON *unread = cJSON_GetObjectItemCaseSensitive(item, "unread");
  const cJSON *group = cJSON_GetObjectItemCaseSensitive(item, "groupId");
  if (level && !cJSON_IsNull(level)) {
    if (!cJSON_IsString(level)) return false;
    const char *names[] = {"quiet", "active", "notice", "action", "fault"};
    for (unsigned i = 0; i < 5; i++)
      if (!strcmp(level->valuestring, names[i])) t->level = (codepulse_ui_level_t)(i + 1);
    /* Unknown future levels degrade to state/unread, preserving the whole page. */
  }
  if (unread && !cJSON_IsNull(unread)) {
    if (!cJSON_IsBool(unread)) return false;
    t->unread_known = true;
    t->unread = cJSON_IsTrue(unread);
  }
  if (group && !cJSON_IsNull(group) && !copy_text(item, "groupId", t->group_id, sizeof(t->group_id))) return false;
  return copy_text(item, "state", t->state_reason, sizeof(t->state_reason));
}
static bool parse_display(const cJSON *root,codepulse_remote_status_t *out) {
  const cJSON *d=cJSON_GetObjectItemCaseSensitive(root,"display");
  if(!d || cJSON_IsNull(d))return true; /* Compatible with the v1 desktop. */
  const cJSON *version=cJSON_GetObjectItemCaseSensitive(d,"version");
  const cJSON *mode=cJSON_GetObjectItemCaseSensitive(d,"mode");
  const cJSON *metric=cJSON_GetObjectItemCaseSensitive(d,"metric");
  const cJSON *quota=cJSON_GetObjectItemCaseSensitive(d,"showQuota");
  const cJSON *env=cJSON_GetObjectItemCaseSensitive(d,"showEnvironment");
  const cJSON *inverted=cJSON_GetObjectItemCaseSensitive(d,"inverted");
  if (inverted && !cJSON_IsBool(inverted)) return false;
  const cJSON *agents=cJSON_GetObjectItemCaseSensitive(d,"agents");
  const cJSON *page=cJSON_GetObjectItemCaseSensitive(d,"page");
  const cJSON *total=cJSON_GetObjectItemCaseSensitive(root,"threadTotal");
  const cJSON *threads=cJSON_GetObjectItemCaseSensitive(root,"threads");
  if(!cJSON_IsObject(d) || !cJSON_IsNumber(version) || version->valuedouble!=1 ||
      !cJSON_IsString(mode) || (strcmp(mode->valuestring,"hud") && strcmp(mode->valuestring,"usage")) ||
      !cJSON_IsString(metric) || (strcmp(metric->valuestring,"used") && strcmp(metric->valuestring,"remaining")) ||
      !cJSON_IsBool(quota) || !cJSON_IsBool(env) || !cJSON_IsArray(agents) ||
      !cJSON_IsNumber(page) || page->valuedouble<0 || page->valuedouble>9999 || page->valuedouble!=(double)(unsigned)page->valuedouble ||
      !cJSON_IsNumber(total) || total->valuedouble<0 || total->valuedouble>100000 || total->valuedouble!=(double)(unsigned)total->valuedouble ||
      !cJSON_IsArray(threads) || cJSON_GetArraySize(threads)>CODEPULSE_UI_MAX_THREADS)return false;
  out->display=(codepulse_display_config_t){.valid=true,.hud=strcmp(mode->valuestring,"hud")==0,
    .remaining=strcmp(metric->valuestring,"remaining")==0,.show_quota=cJSON_IsTrue(quota),.show_environment=cJSON_IsTrue(env),.inverted=cJSON_IsTrue(inverted),.page=(unsigned)page->valuedouble};
  out->thread_total=(unsigned)total->valuedouble;
  const cJSON *item=NULL;cJSON_ArrayForEach(item,agents) {
    codepulse_ui_agent_type_t type;
    if(!cJSON_IsString(item) || !parse_agent_type(item->valuestring,&type))return false;
    out->display.agent_mask|=(uint8_t)(1u<<type);
  }
  cJSON_ArrayForEach(item,threads) {
    codepulse_ui_thread_t *t=&out->threads[out->thread_count];
    const cJSON *type=cJSON_GetObjectItemCaseSensitive(item,"type");
    const cJSON *state=cJSON_GetObjectItemCaseSensitive(item,"state");
    if(!cJSON_IsObject(item) || !copy_text(item,"id",t->id,sizeof(t->id)) || !t->id[0] ||
        !copy_text(item,"title",t->title,sizeof(t->title)) || !copy_text(item,"detail",t->detail,sizeof(t->detail)) ||
        !cJSON_IsString(type) || !parse_agent_type(type->valuestring,&t->type) || !cJSON_IsString(state) ||
        !(out->display.agent_mask&(1u<<t->type)))return false;
    for(size_t i=0;i<out->thread_count;i++)if(!strcmp(out->threads[i].id,t->id))return false;
    t->state=parse_agent_state(state->valuestring);
    if (!parse_thread_presentation(item, t)) return false;
    out->thread_count++;
  }
  if(out->thread_total<out->thread_count || out->display.page*9u+out->thread_count>out->thread_total)return false;
  return true;
}

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
/* Optional color errors discard only red, preserving the valid BW card. */
static void parse_ambient_red(const cJSON *a, codepulse_ambient_t *out) {
  const cJSON *red = cJSON_GetObjectItemCaseSensitive(a, "red");
  if (!cJSON_IsObject(red)) return;
  const char *keys[] = {"x", "y", "w", "h"};
  const unsigned limits[] = {CODEPULSE_AMBIENT_WIDTH, CODEPULSE_AMBIENT_HEIGHT,
                            CODEPULSE_AMBIENT_WIDTH, CODEPULSE_AMBIENT_HEIGHT};
  unsigned rect[4];
  for (unsigned i = 0; i < 4; i++) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(red, keys[i]);
    if (!cJSON_IsNumber(v) || !(v->valuedouble >= 0 && v->valuedouble <= limits[i]) ||
        v->valuedouble != (double)(unsigned)v->valuedouble) return;
    rect[i] = (unsigned)v->valuedouble;
  }
  if (rect[0] % 8 || rect[2] % 8 || rect[2] < 8 || rect[3] < 1 ||
      rect[0] + rect[2] > CODEPULSE_AMBIENT_WIDTH ||
      rect[1] + rect[3] > CODEPULSE_AMBIENT_HEIGHT) return;
  const size_t bytes = rect[2] * rect[3] / 8;
  const cJSON *hex = cJSON_GetObjectItemCaseSensitive(red, "hex");
  if (bytes > sizeof(out->red) || !cJSON_IsString(hex) ||
      strlen(hex->valuestring) != bytes * 2) return;
  /* Validate before copying so discarded rectangles leave no partial data. */
  for (size_t i = 0; i < bytes * 2; i++)
    if (hex_digit(hex->valuestring[i]) < 0) return;
  for (size_t i = 0; i < bytes; i++)
    out->red[i] = (uint8_t)((hex_digit(hex->valuestring[i * 2]) << 4) |
                           hex_digit(hex->valuestring[i * 2 + 1]));
  out->red_x = (uint16_t)rect[0]; out->red_y = (uint16_t)rect[1];
  out->red_w = (uint16_t)rect[2]; out->red_h = (uint16_t)rect[3];
  out->has_red = true;
}
static bool calendar_integer(const cJSON *v, unsigned low, unsigned high, unsigned *out) {
  if (!cJSON_IsNumber(v) || !(v->valuedouble >= low && v->valuedouble <= high) ||
      v->valuedouble != (double)(unsigned)v->valuedouble) return false;
  *out = (unsigned)v->valuedouble;
  return true;
}
static bool calendar_text(const cJSON *v, char *out, size_t capacity, unsigned limit) {
  if (!cJSON_IsString(v) || strlen(v->valuestring) >= capacity) return false;
  const unsigned char *p = (const unsigned char *)v->valuestring;
  unsigned count = 0;
  while (*p) {
    unsigned cp = *p++, remaining = 0, min = 0;
    if (cp < 0x80) { if (cp < 32 || cp == 127) return false; }
    else if (cp >= 0xc2 && cp <= 0xdf) { cp &= 31; remaining = 1; min = 0x80; }
    else if (cp >= 0xe0 && cp <= 0xef) { cp &= 15; remaining = 2; min = 0x800; }
    else if (cp >= 0xf0 && cp <= 0xf4) { cp &= 7; remaining = 3; min = 0x10000; }
    else return false;
    while (remaining--) {
      if ((*p & 0xc0) != 0x80) return false;
      cp = (cp << 6) | (*p++ & 63);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || ++count > limit) return false;
  }
  memcpy(out, v->valuestring, strlen(v->valuestring) + 1);
  return true;
}
static bool parse_calendar(const cJSON *a, codepulse_calendar_t *out) {
  const cJSON *c = cJSON_GetObjectItemCaseSensitive(a, "calendar");
  if (!cJSON_IsObject(c)) return false;
  const char *keys[] = {"year", "month", "today", "first", "days", "week"};
  const unsigned lows[] = {1900, 1, 0, 0, 28, 1}, highs[] = {2100, 12, 31, 6, 31, 53};
  unsigned numbers[6];
  for (unsigned i = 0; i < 6; i++)
    if (!calendar_integer(cJSON_GetObjectItemCaseSensitive(c, keys[i]), lows[i], highs[i], &numbers[i])) return false;
  static const unsigned month_days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
  unsigned days = month_days[numbers[1] - 1];
  if (numbers[1] == 2 && numbers[0] % 4 == 0 && (numbers[0] % 100 != 0 || numbers[0] % 400 == 0)) days++;
  if (numbers[4] != days || numbers[2] > days ||
      !calendar_text(cJSON_GetObjectItemCaseSensitive(c, "lunar"), out->lunar, sizeof(out->lunar), 32)) return false;
  const cJSON *labels = cJSON_GetObjectItemCaseSensitive(c, "labels"), *flags = cJSON_GetObjectItemCaseSensitive(c, "flags");
  if (!cJSON_IsArray(labels) || !cJSON_IsArray(flags) ||
      cJSON_GetArraySize(labels) != (int)days || cJSON_GetArraySize(flags) != (int)days) return false;
  for (unsigned i = 0; i < days; i++) {
    unsigned flag;
    if (!calendar_text(cJSON_GetArrayItem(labels, (int)i), out->labels[i], sizeof(out->labels[i]), 4) ||
        !calendar_integer(cJSON_GetArrayItem(flags, (int)i), 0, 15, &flag) || (flag & 12) == 12) return false;
    out->flags[i] = (uint8_t)flag;
  }
  out->year = (uint16_t)numbers[0]; out->month = (uint8_t)numbers[1];
  out->today = (uint8_t)numbers[2]; out->first = (uint8_t)numbers[3];
  out->days = (uint8_t)days; out->week = (uint8_t)numbers[5];
  return true;
}
static bool life_string(const cJSON *p, const char *key, char *out, size_t size, unsigned max, bool required) {
  if (!calendar_text(cJSON_GetObjectItemCaseSensitive(p, key), out, size, max) || (required && !out[0])) {
    return false;
  }
  for (const unsigned char *c = (const unsigned char *)out; *c; c++)
  {
    if (c[0] == 0xc2 && c[1] >= 0x80 && c[1] <= 0x9f) {
      return false;
    }
  }
  return true;
}
static bool life_number(const cJSON *p, const char *key, char *out, bool required, bool percent) {
  if (!life_string(p, key, out, 17, 16, required)) {
    return false;
  }
  const char *s = out;
  if (!*s) {
    return true;
  }
  if (*s == '-' || *s == '+') {
    s++;
  }
  unsigned before = 0, after = 0;
  while (*s >= '0' && *s <= '9') {
    before++;
    s++;
  }
  if (!before || before > 10) {
    return false;
  }
  if (*s == '.') {
    s++;
    while (*s >= '0' && *s <= '9') {
      after++;
      s++;
    }
    if (!after || after > 6) {
      return false;
    }
  }
  if (*s == '%' && percent) {
    s++;
  }
  return !*s;
}
static bool life_enum(const cJSON *p, const char *key, const char *const *names, unsigned count, unsigned *out) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(p, key);
  if (!cJSON_IsString(value)) {
    return false;
  }
  for (unsigned i = 0; i < count; i++) {
    if (!strcmp(value->valuestring, names[i])) {
      *out = i;
      return true;
    }
  }
  return false;
}
static bool life_iso(const cJSON *p, const char *key, codepulse_life_date_t *out) {
  char s[11];
  if (!life_string(p, key, s, sizeof(s), 10, true) || strlen(s) != 10 || s[4] != '-' || s[7] != '-') {
    return false;
  }
  unsigned y = 0, m = 0, d = 0;
  for (unsigned i = 0; i < 10; i++) {
    if (i != 4 && i != 7) {
      if (s[i] < '0' || s[i] > '9') {
        return false;
      }
      if (i < 4) {
        y = y*10 + (unsigned)(s[i]-'0');
      } else if (i < 7) {
        m = m*10 + (unsigned)(s[i]-'0');
      } else {
        d = d*10 + (unsigned)(s[i]-'0');
      }
    }
  }
  if (y < 1900 || y > 2101 || m < 1 || m > 12 || d < 1 || d > life_month_days(y, m)) {
    return false;
  }
  *out = (codepulse_life_date_t){
    (uint16_t)y, (uint8_t)m, (uint8_t)d
  };
  return true;
}
#define LT(p,key,field,max,required) life_string(p,key,field,sizeof(field),max,required)
#define LN(p,key,field,required,percent) life_number(p,key,field,required,percent)
static bool parse_life(const cJSON *a, codepulse_life_t *out) {
  const cJSON *p = cJSON_GetObjectItemCaseSensitive(a, "life");
  unsigned version, kind, direction;
  static const char *const kinds[] = {
    "weather","gold","stock","tool","news","holiday"
  };
  static const char *const directions[] = {
    "flat","up","down"
  };
  static const char *const weather_icons[] = {
    "sun","cloudsun","cloud","rain","snow","thunder","fog"
  };
  if (!cJSON_IsObject(p) || !calendar_integer(cJSON_GetObjectItemCaseSensitive(p,"v"),1,1,&version) ||
  !life_enum(p,"kind",kinds,6,&kind)) {
    return false;
  }
  out->version = (uint8_t)version;
  out->kind = (codepulse_life_kind_t)(kind + 1);
  if (out->kind == LIFE_WEATHER) {
    codepulse_life_weather_t *w = &out->data.weather;
    unsigned icon;
    if (!life_enum(p,"icon",weather_icons,7,&icon) || !LT(p,"place",w->place,20,false) ||
    !LN(p,"low",w->low,true,false) || !LN(p,"high",w->high,true,false) || !LT(p,"condition",w->condition,16,true) ||
    !LN(p,"feels",w->feels,false,false) || !LT(p,"wind",w->wind,24,false) ||
    !LN(p,"humidity",w->humidity,false,false) || !LN(p,"air",w->air,false,false) ||
    !LT(p,"restriction",w->restriction,16,false) || !LT(p,"sunset",w->sunset,5,false)) {
      return false;
    }
    w->icon = (uint8_t)icon;
    if (w->sunset[0] && (strlen(w->sunset) != 5 || w->sunset[2] != ':' ||
    w->sunset[0] < '0' || w->sunset[0] > '2' || w->sunset[1] < '0' || w->sunset[1] > '9' ||
    (w->sunset[0] == '2' && w->sunset[1] > '3') || w->sunset[3] < '0' || w->sunset[3] > '5' ||
    w->sunset[4] < '0' || w->sunset[4] > '9')) {
      return false;
    }
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(p,"tomorrow");
    if (t) {
      if (!cJSON_IsObject(t) || !life_enum(t,"icon",weather_icons,7,&icon) ||
      !LN(t,"low",w->tomorrow_low,true,false) || !LN(t,"high",w->tomorrow_high,true,false) ||
      !LT(t,"condition",w->tomorrow_condition,16,true)) {
        return false;
      }
      w->has_tomorrow = true;
      w->tomorrow_icon = (uint8_t)icon;
    }
    return true;
  }
  if (out->kind == LIFE_GOLD) {
    codepulse_life_gold_t *g = &out->data.gold;
    if (!life_enum(p,"direction",directions,3,&direction) || !LN(p,"hero",g->hero,true,false) ||
    !LN(p,"percent",g->percent,false,true) || !LN(p,"change",g->change,false,false) ||
    !LN(p,"low",g->low,false,false) || !LN(p,"high",g->high,false,false) ||
    !LN(p,"international",g->international,false,false) || !LN(p,"internationalPercent",g->international_percent,false,true) ||
    !LT(p,"brand",g->brand,12,false) || !LN(p,"brandPrice",g->brand_price,false,false) || !LT(p,"source",g->source,20,false)) {
      return false;
    }
    g->direction = (codepulse_life_direction_t)direction;
    return true;
  }
  if (out->kind == LIFE_STOCK) {
    static const char *const states[] = {
      "unknown","open","closed"
    };
    codepulse_life_stock_t *s = &out->data.stock;
    unsigned state;
    if (!life_enum(p,"direction",directions,3,&direction) || !life_enum(p,"state",states,3,&state) ||
    !LT(p,"name",s->name,20,false) || !LT(p,"symbol",s->symbol,16,true) ||
    !LN(p,"hero",s->hero,true,false) || !LN(p,"percent",s->percent,false,true) || !LN(p,"change",s->change,false,false) ||
    !LN(p,"low",s->low,false,false) || !LN(p,"high",s->high,false,false) ||
    !LN(p,"open",s->open,false,false) || !LN(p,"previous",s->previous,false,false) || !LT(p,"source",s->source,20,false)) {
      return false;
    }
    char *dot = strchr(s->symbol,'.');
    if (!dot || dot == s->symbol || dot - s->symbol > 10 ||
    (strcmp(dot,".US") && strcmp(dot,".HK") && strcmp(dot,".SH") && strcmp(dot,".SZ"))) {
      return false;
    }
    for (const char *c = s->symbol; c < dot; c++) {
      if (!(*c >= 'A' && *c <= 'Z') && !(*c >= '0' && *c <= '9')) {
        return false;
      }
    }
    s->direction = (codepulse_life_direction_t)direction;
    s->state = (uint8_t)state;
    return true;
  }
  if (out->kind == LIFE_TOOL) {
    static const char *const icons[] = {
      "codex","claude","tool"
    };
    codepulse_life_tool_t *t = &out->data.tool;
    unsigned icon;
    if (!life_enum(p,"icon",icons,3,&icon) || !LT(p,"name",t->name,24,true) || !LT(p,"date",t->date,12,false) ||
    !LT(p,"source",t->source,8,false) || !LT(p,"command",t->command,20,false) ||
    !LT(p,"title",t->title,48,true) || !LT(p,"summary",t->summary,96,false)) {
      return false;
    }
    for (const unsigned char *c = (const unsigned char *)t->command; *c; c++) {
      if (*c < 32 || *c > 126) {
        return false;
      }
    }
    t->icon = (uint8_t)icon;
    return true;
  }
  if (out->kind == LIFE_NEWS) {
    codepulse_life_news_t *n = &out->data.news;
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(p,"headlines");
    if (!cJSON_IsArray(items) || cJSON_GetArraySize(items) < 1 || cJSON_GetArraySize(items) > CODEPULSE_LIFE_HEADLINES) {
      return false;
    }
    const cJSON *item;
    cJSON_ArrayForEach(item,items) {
      codepulse_life_headline_t *h = &n->headlines[n->count];
      if (!cJSON_IsObject(item) || !LT(item,"title",h->title,28,true) || !LT(item,"source",h->source,8,false)) {
        return false;
      }
      n->count++;
    }
    return true;
  }
  if (out->kind == LIFE_HOLIDAY) {
    static const char *const states[] = {
      "pending","published"
    };
    codepulse_life_holiday_t *h = &out->data.holiday;
    unsigned year, state, days;
    if (!calendar_integer(cJSON_GetObjectItemCaseSensitive(p,"year"),1900,2100,&year) ||
    !life_enum(p,"state",states,2,&state) || !LT(p,"label",h->label,12,false)) {
      return false;
    }
    h->year = (uint16_t)year;
    h->published = state == 1;
    const cJSON *next = cJSON_GetObjectItemCaseSensitive(p,"next");
    if (!cJSON_IsObject(next) || !LT(next,"name",h->next_name,12,true) || !life_iso(next,"date",&h->next) ||
    !calendar_integer(cJSON_GetObjectItemCaseSensitive(next,"days"),0,366,&days)) {
      return false;
    }
    h->next_days = (uint16_t)days;
    const cJSON *r = cJSON_GetObjectItemCaseSensitive(p,"range");
    if (r) {
      if (!h->published || !cJSON_IsObject(r) || !LT(r,"name",h->name,12,true) || !life_iso(r,"start",&h->start) ||
      !life_iso(r,"end",&h->end) || !calendar_integer(cJSON_GetObjectItemCaseSensitive(r,"days"),1,31,&days) ||
      life_ordinal(h->end) - life_ordinal(h->start) + 1 != (int)days) {
        return false;
      }
      h->days = (uint8_t)days;
      h->has_range = true;
      if (!((h->start.year == h->year && h->end.year == h->year) ||
      (!strcmp(h->name,"元旦") && h->start.year + 1 == h->year && h->start.month == 12 && h->end.year == h->year && h->end.month == 1))) {
        return false;
      }
    }
    return true;
  }
  return false;
}
#undef LT
#undef LN
static bool parse_ambient(const cJSON *root, codepulse_ambient_t *out) {
  const cJSON *a = cJSON_GetObjectItemCaseSensitive(root, "ambient");
  if (!a || cJSON_IsNull(a)) return true;
  if (!cJSON_IsObject(a) || !copy_text(a, "id", out->id, sizeof(out->id)) || !out->id[0] ||
      !copy_text(a, "source", out->source, sizeof(out->source)) ||
      !copy_text(a, "text", out->text, sizeof(out->text))) return false;
  const cJSON *manual = cJSON_GetObjectItemCaseSensitive(a, "manual");
  if (manual && !cJSON_IsBool(manual)) return false;
  out->manual = cJSON_IsTrue(manual);
  const cJSON *layout = cJSON_GetObjectItemCaseSensitive(a, "layout");
  if (cJSON_IsString(layout) && !strcmp(layout->valuestring, "life")) {
    const cJSON *image = cJSON_GetObjectItemCaseSensitive(a,"imageHex");
    if ((!image || cJSON_IsNull(image)) && !cJSON_GetObjectItemCaseSensitive(a,"items") && parse_life(a,&out->life)) {
      out->layout = CODEPULSE_AMBIENT_LAYOUT_LIFE;
      return true;
    }
    memset(&out->life,0,sizeof(out->life));
  }
  if (cJSON_IsString(layout) && !strcmp(layout->valuestring, "calendar")) {
    if (parse_calendar(a, &out->calendar)) {
      out->layout = CODEPULSE_AMBIENT_LAYOUT_CALENDAR;
      return true;
    }
    memset(&out->calendar, 0, sizeof(out->calendar));
  }
  const cJSON *items = cJSON_GetObjectItemCaseSensitive(a, "items");
  if (items) {
    if (!cJSON_IsArray(items) || cJSON_GetArraySize(items) > CODEPULSE_AMBIENT_MAX_ITEMS) return false;
    out->has_items = true;
    const cJSON *item;
    cJSON_ArrayForEach(item, items) {
      codepulse_ambient_item_t *entry = &out->items[out->item_count];
      const cJSON *overdue = cJSON_GetObjectItemCaseSensitive(item, "overdue");
      if (!cJSON_IsObject(item) || !copy_text(item,"title",entry->title,sizeof(entry->title)) || !entry->title[0] ||
          !copy_text(item,"meta",entry->meta,sizeof(entry->meta)) || !cJSON_IsBool(overdue)) return false;
      entry->overdue = cJSON_IsTrue(overdue);
      out->item_count++;
    }
  }
  const cJSON *image = cJSON_GetObjectItemCaseSensitive(a, "imageHex");
  if (!image || cJSON_IsNull(image)) return true;
  if (out->has_items) return false;
  if (!cJSON_IsString(image) || strlen(image->valuestring) != CODEPULSE_AMBIENT_BYTES * 2) return false;
  for (size_t i = 0; i < CODEPULSE_AMBIENT_BYTES; i++) {
    int high = hex_digit(image->valuestring[i * 2]), low = hex_digit(image->valuestring[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    out->image[i] = (uint8_t)((high << 4) | low);
  }
  out->has_image = true;
  if (cJSON_IsString(layout) && !strcmp(layout->valuestring, "pet"))
    out->layout = CODEPULSE_AMBIENT_LAYOUT_PET;
  parse_ambient_red(a, out);
  return true;
}

esp_err_t codepulse_protocol_parse(const char *json, size_t length,
                                   codepulse_remote_status_t *status) {
  if (json == NULL || length == 0 || status == NULL) {
    return ESP_ERR_INVALID_ARG;
  }

  const char *parse_end = NULL;
  cJSON *root = cJSON_ParseWithLengthOpts(json, length, &parse_end, false);
  const char *const json_end = json + length;
  while (parse_end != NULL && parse_end < json_end &&
         isspace((unsigned char)*parse_end)) {
    ++parse_end;
  }
  if (!cJSON_IsObject(root) || parse_end != json_end) {
    cJSON_Delete(root);
    return ESP_ERR_INVALID_RESPONSE;
  }

  esp_err_t result = ESP_ERR_INVALID_RESPONSE;
  codepulse_remote_status_t *parsed = NULL;
  const cJSON *version =
      cJSON_GetObjectItemCaseSensitive(root, "protocolVersion");
  const cJSON *revision = cJSON_GetObjectItemCaseSensitive(root, "revision");
  const cJSON *main_state = cJSON_GetObjectItemCaseSensitive(root, "mainState");
  const cJSON *agents = cJSON_GetObjectItemCaseSensitive(root, "agents");
  if (!cJSON_IsNumber(version) ||
      version->valuedouble != (double)CODEPULSE_PROTOCOL_VERSION ||
      !cJSON_IsString(revision) || revision->valuestring == NULL ||
      strlen(revision->valuestring) == 0 ||
      strlen(revision->valuestring) > CODEPULSE_REVISION_MAX_BYTES ||
      !cJSON_IsString(main_state) || main_state->valuestring == NULL ||
      strlen(main_state->valuestring) > CODEPULSE_MAIN_STATE_MAX_BYTES ||
      !cJSON_IsArray(agents)) {
    goto cleanup;
  }

  parsed = malloc(sizeof(*parsed));
  if (!parsed) goto cleanup;
  codepulse_remote_status_reset(parsed);
  memcpy(parsed->revision, revision->valuestring,
         strlen(revision->valuestring) + 1);
  memcpy(parsed->main_state, main_state->valuestring,
         strlen(main_state->valuestring) + 1);

  const cJSON *agent_object = NULL;
  cJSON_ArrayForEach(agent_object, agents) {
    if (!cJSON_IsObject(agent_object)) {
      continue;
    }
    const cJSON *type_value =
        cJSON_GetObjectItemCaseSensitive(agent_object, "type");
    const cJSON *state_value =
        cJSON_GetObjectItemCaseSensitive(agent_object, "state");
    if (!cJSON_IsString(type_value) || type_value->valuestring == NULL ||
        !cJSON_IsString(state_value) || state_value->valuestring == NULL) {
      continue;
    }

    codepulse_ui_agent_type_t type;
    if (!parse_agent_type(type_value->valuestring, &type)) {
      continue;
    }
    codepulse_remote_agent_t *agent = agent_for_type(parsed, type);
    if (agent == NULL) {
      continue;
    }
    agent->state = parse_agent_state(state_value->valuestring);
    // v1 includes account-only quota rows with idle state and no project.
    // Retain their quota, but do not imply that a CLI session is open.
    const cJSON *project = cJSON_GetObjectItemCaseSensitive(agent_object, "project");
    if (agent->state == CODEPULSE_UI_AGENT_IDLE && cJSON_IsNull(project)) {
      agent->state = CODEPULSE_UI_AGENT_OFFLINE;
    }

    const cJSON *model_value =
        cJSON_GetObjectItemCaseSensitive(agent_object, "model");
    const char *model =
        cJSON_IsString(model_value) ? model_value->valuestring : NULL;
    parse_tokens(agent_object, agent);
    parse_quotas(agent_object, model, agent);
    if (!parse_quota_summary(agent_object, agent)) goto cleanup;
    const cJSON *quotas = cJSON_GetObjectItemCaseSensitive(agent_object, "quotas");
    int best = INT_MIN; const cJSON *bucket = NULL;
    cJSON_ArrayForEach(bucket, quotas) {
      if (!cJSON_IsObject(bucket) || (quota_window_percent(bucket, "weekly") < 0 && quota_window_percent(bucket, "fiveHour") < 0)) continue;
      int priority = quota_priority(bucket, type, model);
      if (priority <= best) continue;
      best = priority;
      const cJSON *reset = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(bucket, "weekly"), "resetsAt");
      parsed->weekly_resets[type] = cJSON_IsNumber(reset) && reset->valuedouble > 0 && reset->valuedouble < 4102444800.0 ? (uint64_t)reset->valuedouble : 0;
    }
  }

  if (!parse_display(root, parsed)) goto cleanup;
  if (!parse_ambient(root, &parsed->ambient)) goto cleanup;
  parsed->valid = true;
  *status = *parsed;
  result = ESP_OK;

cleanup:
  free(parsed);
  cJSON_Delete(root);
  return result;
}

/* Shared projection for the MCU and pixel-exact desktop preview. Local sensor
 * fields are intentionally retained; this function applies only LAN data. */
void codepulse_remote_apply(const codepulse_remote_status_t *remote,
                            codepulse_ui_model_t *model) {
  if (!model) return;
  model->ambient = NULL;
  model->ambient_id[0] = 0;
  if (remote != NULL && remote->valid) {
    const size_t count = remote->agent_count > CODEPULSE_UI_MAX_AGENTS
                             ? CODEPULSE_UI_MAX_AGENTS
                             : remote->agent_count;
    for (size_t index = 0; index < count; ++index) {
      model->agents[index] = (codepulse_ui_agent_t){
          .type = remote->agents[index].type,
          .state = remote->agents[index].state,
          .five_hour_percent = remote->agents[index].five_hour_percent,
          .weekly_percent = remote->agents[index].weekly_percent,
      };
    }
    model->agent_count = count;
  }
  if (remote && remote->valid) {
    bool attention = (!remote->ambient.manual && !strcmp(remote->main_state, "done")) || !strcmp(remote->main_state, "waiting_permission") ||
        !strcmp(remote->main_state, "error") || !strcmp(remote->main_state, "stuck") || !strcmp(remote->main_state, "usage_limited");
    for (size_t i = 0; i < remote->agent_count; i++) {
      codepulse_ui_agent_state_t state = remote->agents[i].state;
      if (state == CODEPULSE_UI_AGENT_WAITING ||
          state == CODEPULSE_UI_AGENT_ERROR || state == CODEPULSE_UI_AGENT_LIMITED) attention = true;
    }
    bool host_levels = false;
    for (size_t i = 0; i < remote->thread_count; i++)
      if (remote->threads[i].level != CODEPULSE_LEVEL_LEGACY) host_levels = true;
    /* A modern host has already gated ambient content using all HUD cards.
     * Do not reinterpret a retained, read terminal state as a fresh alert. */
    if (host_levels) attention = false;
    for (size_t i = 0; i < remote->thread_count; i++)
      if (codepulse_thread_level(&remote->threads[i]) >=
          (remote->ambient.manual ? CODEPULSE_LEVEL_ACTION : CODEPULSE_LEVEL_NOTICE)) attention = true;
    if (remote->ambient.id[0] && !attention) {
      model->ambient = &remote->ambient;
      memcpy(model->ambient_id, remote->ambient.id, sizeof(model->ambient_id));
    }
    model->display = remote->display;
    model->thread_count = remote->thread_count;
    model->thread_total = remote->thread_total;
    memcpy(model->threads, remote->threads, sizeof(model->threads));
    memcpy(model->weekly_resets, remote->weekly_resets, sizeof(model->weekly_resets));
  }
}
