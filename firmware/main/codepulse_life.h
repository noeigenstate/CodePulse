#pragma once
#include <stdbool.h>
#include <stdint.h>
#define CODEPULSE_LIFE_VERSION 1
#define CODEPULSE_LIFE_HEADLINES 4
#define CODEPULSE_LIFE_STORIES 4
typedef enum {
  LIFE_NONE, LIFE_WEATHER, LIFE_GOLD, LIFE_STOCK, LIFE_TOOL, LIFE_NEWS, LIFE_HOLIDAY,
  LIFE_CONCEPT, LIFE_PROMPT, LIFE_HN
}
codepulse_life_kind_t;
typedef enum {
  LIFE_FLAT, LIFE_UP, LIFE_DOWN
}
codepulse_life_direction_t;
typedef struct {
  uint8_t icon, tomorrow_icon;
  bool has_tomorrow;
  char place[81], low[17], high[17], condition[65], feels[17], wind[97];
  char humidity[17], air[17], restriction[65], sunset[6];
  char tomorrow_low[17], tomorrow_high[17], tomorrow_condition[65];
}
codepulse_life_weather_t;
typedef struct {
  codepulse_life_direction_t direction;
  char hero[17], percent[17], change[17], low[17], high[17];
  char international[17], international_percent[17], brand[49], brand_price[17], source[81];
}
codepulse_life_gold_t;
typedef struct {
  codepulse_life_direction_t direction;
  uint8_t state;
  /* 0 unknown, 1 open, 2 closed */
  char name[81], symbol[17], hero[17], percent[17], change[17], low[17], high[17];
  char open[17], previous[17], source[81];
}
codepulse_life_stock_t;
typedef struct {
  uint8_t icon;
  char name[97], date[49], source[33], command[21], title[193], summary[385];
}
codepulse_life_tool_t;
typedef struct {
  char title[113], source[33];
}
codepulse_life_headline_t;
typedef struct {
  uint8_t count;
  codepulse_life_headline_t headlines[CODEPULSE_LIFE_HEADLINES];
}
codepulse_life_news_t;
typedef struct {
  uint16_t year;
  uint8_t month, day;
}
codepulse_life_date_t;
typedef struct {
  uint16_t year, next_days;
  bool published, has_range;
  uint8_t days;
  char next_name[49], name[49], label[49];
  codepulse_life_date_t next, start, end;
}
codepulse_life_holiday_t;
/* Reading cards (0.0.32-cards): built-in concepts and prompts, and the Hacker News digest. */
typedef struct {
  char subject[25], position[37], term[25], english[97], definition[177], example[177], question[81];
}
codepulse_life_concept_t;
typedef struct {
  uint8_t line_count;
  char tag[25], lead[89], lines[2][45], follow[93];
}
codepulse_life_prompt_t;
typedef struct {
  uint32_t points, comments;
  char title[481], site[129], age[33];
}
codepulse_life_story_t;
typedef struct {
  uint8_t count;
  char updated[21];
  codepulse_life_story_t stories[CODEPULSE_LIFE_STORIES];
}
codepulse_life_hn_t;
typedef struct {
  uint8_t version;
  codepulse_life_kind_t kind;
  union {
    codepulse_life_weather_t weather;
    codepulse_life_gold_t gold;
    codepulse_life_stock_t stock;
    codepulse_life_tool_t tool;
    codepulse_life_news_t news;
    codepulse_life_holiday_t holiday;
    codepulse_life_concept_t concept;
    codepulse_life_prompt_t prompt;
    codepulse_life_hn_t hn;
  }
  data;
}
codepulse_life_t;
/* Gregorian civil dates only: no MCU clock, network, or inferred holiday arrangement. */
static inline unsigned life_month_days(unsigned year, unsigned month) {
  static const unsigned days[] = {
    31,28,31,30,31,30,31,31,30,31,30,31
  };
  return days[month - 1] + (month == 2 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
}
static inline int life_ordinal(codepulse_life_date_t d) {
  unsigned y = d.year - 1;
  int n = (int)(365*y + y/4 - y/100 + y/400 + d.day - 1);
  for (unsigned m = 1; m < d.month; m++) {
    n += (int)life_month_days(d.year, m);
  }
  return n;
}
static inline codepulse_life_date_t life_next_date(codepulse_life_date_t d) {
  if (++d.day > life_month_days(d.year, d.month)) {
    d.day = 1;
    if (++d.month > 12) {
      d.month = 1;
      d.year++;
    }
  }
  return d;
}
