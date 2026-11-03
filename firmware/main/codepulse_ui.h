#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "epd_canvas.h"
#include "codepulse_life.h"

#define CODEPULSE_UI_MAX_AGENTS 3
#define CODEPULSE_UI_PERCENT_UNKNOWN (-1)

typedef enum {
  CODEPULSE_UI_AGENT_CLAUDE,
  CODEPULSE_UI_AGENT_CODEX,
  CODEPULSE_UI_AGENT_GROK,
} codepulse_ui_agent_type_t;

typedef enum {
  CODEPULSE_UI_AGENT_OFFLINE,
  CODEPULSE_UI_AGENT_IDLE,
  CODEPULSE_UI_AGENT_RUNNING,
  CODEPULSE_UI_AGENT_WAITING,
  CODEPULSE_UI_AGENT_DONE,
  CODEPULSE_UI_AGENT_ERROR,
  CODEPULSE_UI_AGENT_LIMITED,
} codepulse_ui_agent_state_t;

typedef struct {
  codepulse_ui_agent_type_t type;
  codepulse_ui_agent_state_t state;
  /* 0..100, or CODEPULSE_UI_PERCENT_UNKNOWN until LAN data is available. */
  int five_hour_percent;
  int weekly_percent;
} codepulse_ui_agent_t;


#define CODEPULSE_UI_MAX_THREADS 9
typedef struct {
  bool valid, hud, remaining, show_quota, show_environment, inverted;
  uint8_t agent_mask;
  unsigned page;
} codepulse_display_config_t;
/* Presentation levels come from the host, never from a device expiry timer. */
typedef enum {
  CODEPULSE_LEVEL_LEGACY,
  CODEPULSE_LEVEL_QUIET,
  CODEPULSE_LEVEL_ACTIVE,
  CODEPULSE_LEVEL_NOTICE,
  CODEPULSE_LEVEL_ACTION,
  CODEPULSE_LEVEL_FAULT,
} codepulse_ui_level_t;
typedef struct {
  char id[25], title[97], detail[97];
  char group_id[25], state_reason[32];
  codepulse_ui_level_t level;
  bool unread_known, unread;
  codepulse_ui_agent_type_t type;
  codepulse_ui_agent_state_t state;
} codepulse_ui_thread_t;

/* Older v1 hosts omit level/unread. Explicit host levels always take priority. */
static inline codepulse_ui_level_t codepulse_thread_level(const codepulse_ui_thread_t *t) {
  if (t->level != CODEPULSE_LEVEL_LEGACY) return t->level;
  switch (t->state) {
  case CODEPULSE_UI_AGENT_RUNNING: return CODEPULSE_LEVEL_ACTIVE;
  case CODEPULSE_UI_AGENT_WAITING: return CODEPULSE_LEVEL_ACTION;
  case CODEPULSE_UI_AGENT_DONE:
    return t->unread_known && !t->unread ? CODEPULSE_LEVEL_QUIET : CODEPULSE_LEVEL_NOTICE;
  case CODEPULSE_UI_AGENT_ERROR:
  case CODEPULSE_UI_AGENT_LIMITED:
    return t->unread_known && !t->unread ? CODEPULSE_LEVEL_QUIET : CODEPULSE_LEVEL_FAULT;
  default: return CODEPULSE_LEVEL_QUIET;
  }
}
static inline bool codepulse_thread_attention(const codepulse_ui_thread_t *t) {
  return codepulse_thread_level(t) >= CODEPULSE_LEVEL_NOTICE;
}

#define CODEPULSE_AMBIENT_WIDTH 384
#define CODEPULSE_AMBIENT_HEIGHT 208
#define CODEPULSE_AMBIENT_BYTES (CODEPULSE_AMBIENT_WIDTH * CODEPULSE_AMBIENT_HEIGHT / 8)
#define CODEPULSE_AMBIENT_MAX_ITEMS 6
#define CODEPULSE_AMBIENT_RED_MAX_BYTES 3072
typedef struct { char title[160], meta[48]; bool overdue; } codepulse_ambient_item_t;
typedef enum {
  CODEPULSE_AMBIENT_LAYOUT_LEGACY,
  CODEPULSE_AMBIENT_LAYOUT_PET,
  CODEPULSE_AMBIENT_LAYOUT_CALENDAR,
  CODEPULSE_AMBIENT_LAYOUT_LIFE,
} codepulse_ambient_layout_t;
typedef struct {
  uint16_t year;
  uint8_t month, today, first, days, week;
  char lunar[33], labels[31][17];
  uint8_t flags[31];
} codepulse_calendar_t;

typedef struct {
  char id[25], source[64], text[768];
  bool has_image, manual, has_red;
  uint16_t red_x, red_y, red_w, red_h;
  codepulse_ambient_layout_t layout;
  codepulse_calendar_t calendar;
  codepulse_life_t life;
  bool has_items;
  size_t item_count;
  codepulse_ambient_item_t items[CODEPULSE_AMBIENT_MAX_ITEMS];
  uint8_t image[CODEPULSE_AMBIENT_BYTES];
  uint8_t red[CODEPULSE_AMBIENT_RED_MAX_BYTES];
} codepulse_ambient_t;

typedef struct {
  /* Borrowed from the single network owner's current remote snapshot. The
   * copied ID remains stable in sync history; pixel data is never duplicated
   * into model/target/history on the small MCU task stack. */
  const codepulse_ambient_t *ambient;
  char ambient_id[25];
  codepulse_display_config_t display;
  codepulse_ui_thread_t threads[CODEPULSE_UI_MAX_THREADS];
  size_t thread_count;
  unsigned thread_total;
  uint64_t weekly_resets[CODEPULSE_UI_MAX_AGENTS];
  bool environment_valid;
  float temperature_c;
  float humidity_rh;

  bool battery_valid;
  uint8_t battery_percent;
  bool wifi_connected;

  codepulse_ui_agent_t agents[CODEPULSE_UI_MAX_AGENTS];
  size_t agent_count;
} codepulse_ui_model_t;

/* Renders the complete 400x300 CodePulse dashboard into both color planes. */
void codepulse_ui_render(epd_canvas_t *canvas,
                         const codepulse_ui_model_t *model);
