#include "codepulse_ui.h"

#include <stdio.h>
#include <string.h>

#include "board_pins.h"

_Static_assert(BOARD_EPD_WIDTH == 400, "CodePulse UI requires a 400px panel");
_Static_assert(BOARD_EPD_HEIGHT == 300, "CodePulse UI requires a 300px panel");

#define UI_MARGIN 8
#define UI_CARD_WIDTH (BOARD_EPD_WIDTH - 2 * UI_MARGIN)

typedef struct {
  const char *name;
  const char *status;
  epd_color_t status_color;
} agent_style_t;

static int absolute_value(int value) { return value < 0 ? -value : value; }

static void draw_line(epd_canvas_t *canvas, int x0, int y0, int x1, int y1,
                      epd_color_t color) {
  const int dx = absolute_value(x1 - x0);
  const int sx = x0 < x1 ? 1 : -1;
  const int dy = -absolute_value(y1 - y0);
  const int sy = y0 < y1 ? 1 : -1;
  int error = dx + dy;

  for (;;) {
    epd_canvas_pixel(canvas, x0, y0, color);
    if (x0 == x1 && y0 == y1) {
      break;
    }
    const int doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x0 += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}

static void draw_thick_line(epd_canvas_t *canvas, int x0, int y0, int x1,
                            int y1, int thickness, epd_color_t color) {
  const int offset_start = -(thickness / 2);
  const int offset_end = offset_start + thickness;
  const bool horizontal = absolute_value(x1 - x0) >= absolute_value(y1 - y0);
  for (int offset = offset_start; offset < offset_end; ++offset) {
    draw_line(canvas, x0 + (horizontal ? 0 : offset),
              y0 + (horizontal ? offset : 0), x1 + (horizontal ? 0 : offset),
              y1 + (horizontal ? offset : 0), color);
  }
}

static void draw_rect(epd_canvas_t *canvas, int x, int y, int width, int height,
                      epd_color_t color) {
  epd_canvas_fill_rect(canvas, x, y, width, 1, color);
  epd_canvas_fill_rect(canvas, x, y + height - 1, width, 1, color);
  epd_canvas_fill_rect(canvas, x, y, 1, height, color);
  epd_canvas_fill_rect(canvas, x + width - 1, y, 1, height, color);
}

static void draw_rounded_rect(epd_canvas_t *canvas, int x, int y, int width,
                              int height, epd_color_t color) {
  epd_canvas_fill_rect(canvas, x + 3, y, width - 6, 1, color);
  epd_canvas_fill_rect(canvas, x + 3, y + height - 1, width - 6, 1, color);
  epd_canvas_fill_rect(canvas, x, y + 3, 1, height - 6, color);
  epd_canvas_fill_rect(canvas, x + width - 1, y + 3, 1, height - 6, color);
  epd_canvas_pixel(canvas, x + 1, y + 1, color);
  epd_canvas_pixel(canvas, x + 2, y + 1, color);
  epd_canvas_pixel(canvas, x + 1, y + 2, color);
  epd_canvas_pixel(canvas, x + width - 2, y + 1, color);
  epd_canvas_pixel(canvas, x + width - 3, y + 1, color);
  epd_canvas_pixel(canvas, x + width - 2, y + 2, color);
  epd_canvas_pixel(canvas, x + 1, y + height - 2, color);
  epd_canvas_pixel(canvas, x + 2, y + height - 2, color);
  epd_canvas_pixel(canvas, x + 1, y + height - 3, color);
  epd_canvas_pixel(canvas, x + width - 2, y + height - 2, color);
  epd_canvas_pixel(canvas, x + width - 3, y + height - 2, color);
  epd_canvas_pixel(canvas, x + width - 2, y + height - 3, color);
}

static void draw_circle_points(epd_canvas_t *canvas, int center_x, int center_y,
                               int x, int y, epd_color_t color) {
  epd_canvas_pixel(canvas, center_x + x, center_y + y, color);
  epd_canvas_pixel(canvas, center_x - x, center_y + y, color);
  epd_canvas_pixel(canvas, center_x + x, center_y - y, color);
  epd_canvas_pixel(canvas, center_x - x, center_y - y, color);
  epd_canvas_pixel(canvas, center_x + y, center_y + x, color);
  epd_canvas_pixel(canvas, center_x - y, center_y + x, color);
  epd_canvas_pixel(canvas, center_x + y, center_y - x, color);
  epd_canvas_pixel(canvas, center_x - y, center_y - x, color);
}

static void draw_circle(epd_canvas_t *canvas, int center_x, int center_y,
                        int radius, epd_color_t color) {
  int x = radius;
  int y = 0;
  int error = 1 - radius;

  while (x >= y) {
    draw_circle_points(canvas, center_x, center_y, x, y, color);
    ++y;
    if (error < 0) {
      error += 2 * y + 1;
    } else {
      --x;
      error += 2 * (y - x) + 1;
    }
  }
}

static void fill_circle(epd_canvas_t *canvas, int center_x, int center_y,
                        int radius, epd_color_t color) {
  const int radius_squared = radius * radius;
  for (int y = -radius; y <= radius; ++y) {
    for (int x = -radius; x <= radius; ++x) {
      if (x * x + y * y <= radius_squared) {
        epd_canvas_pixel(canvas, center_x + x, center_y + y, color);
      }
    }
  }
}

static void draw_brand_mark(epd_canvas_t *canvas) {
  draw_circle(canvas, 23, 21, 13, EPD_COLOR_RED);
  draw_thick_line(canvas, 13, 21, 17, 21, 2, EPD_COLOR_RED);
  draw_thick_line(canvas, 17, 21, 20, 14, 2, EPD_COLOR_RED);
  draw_thick_line(canvas, 20, 14, 24, 28, 2, EPD_COLOR_RED);
  draw_thick_line(canvas, 24, 28, 27, 18, 2, EPD_COLOR_RED);
  draw_thick_line(canvas, 27, 18, 30, 21, 2, EPD_COLOR_RED);
  draw_thick_line(canvas, 30, 21, 34, 21, 2, EPD_COLOR_RED);
}

static void draw_wifi_icon(epd_canvas_t *canvas, bool connected) {
  draw_thick_line(canvas, 252, 16, 257, 12, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 257, 12, 264, 12, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 264, 12, 269, 16, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 256, 20, 259, 17, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 259, 17, 262, 17, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 262, 17, 266, 20, 2, EPD_COLOR_BLACK);
  fill_circle(canvas, 261, 24, 2, EPD_COLOR_BLACK);
  if (!connected) {
    draw_thick_line(canvas, 251, 11, 270, 27, 2, EPD_COLOR_RED);
  }
}

static void draw_battery(epd_canvas_t *canvas, bool valid, int percent) {
  draw_rounded_rect(canvas, 359, 11, 29, 17, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 388, 16, 3, 7, EPD_COLOR_BLACK);
  if (!valid) {
    draw_thick_line(canvas, 363, 14, 383, 25, 2, EPD_COLOR_RED);
    draw_thick_line(canvas, 383, 14, 363, 25, 2, EPD_COLOR_RED);
    return;
  }

  const int clamped = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
  const int fill_width = clamped * 23 / 100;
  if (fill_width > 0) {
    epd_canvas_fill_rect(canvas, 362, 14, fill_width, 11,
                         clamped <= 20 ? EPD_COLOR_RED : EPD_COLOR_BLACK);
  }
}

static void draw_thermometer(epd_canvas_t *canvas) {
  draw_rounded_rect(canvas, 26, 59, 9, 29, EPD_COLOR_BLACK);
  draw_circle(canvas, 30, 90, 9, EPD_COLOR_BLACK);
  fill_circle(canvas, 30, 90, 6, EPD_COLOR_RED);
  epd_canvas_fill_rect(canvas, 29, 66, 3, 23, EPD_COLOR_RED);
  epd_canvas_fill_rect(canvas, 38, 66, 5, 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 38, 73, 4, 2, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 38, 80, 5, 2, EPD_COLOR_BLACK);
}

static void draw_droplet(epd_canvas_t *canvas) {
  draw_thick_line(canvas, 221, 58, 211, 77, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 221, 58, 231, 77, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 211, 77, 211, 86, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 231, 77, 231, 86, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 211, 86, 216, 94, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 231, 86, 226, 94, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 216, 94, 226, 94, 2, EPD_COLOR_BLACK);
  draw_thick_line(canvas, 216, 83, 218, 88, 2, EPD_COLOR_RED);
  draw_thick_line(canvas, 218, 88, 222, 90, 2, EPD_COLOR_RED);
  draw_thick_line(canvas, 222, 90, 226, 87, 2, EPD_COLOR_RED);
}

static agent_style_t agent_style(const codepulse_ui_agent_t *agent) {
  agent_style_t style = {
      .name = "AGENT",
      .status = "OFFLINE",
      .status_color = EPD_COLOR_BLACK,
  };

  switch (agent->type) {
  case CODEPULSE_UI_AGENT_CLAUDE:
    style.name = "CLAUDE";
    break;
  case CODEPULSE_UI_AGENT_CODEX:
    style.name = "CODEX";
    break;
  case CODEPULSE_UI_AGENT_GROK:
    style.name = "GROK";
    break;
  default:
    break;
  }

  switch (agent->state) {
  case CODEPULSE_UI_AGENT_IDLE:
    style.status = "IDLE";
    break;
  case CODEPULSE_UI_AGENT_RUNNING:
    style.status = "ACTIVE";
    style.status_color = EPD_COLOR_RED;
    break;
  case CODEPULSE_UI_AGENT_WAITING:
    style.status = "WAIT";
    style.status_color = EPD_COLOR_RED;
    break;
  case CODEPULSE_UI_AGENT_DONE:
    style.status = "DONE";
    break;
  case CODEPULSE_UI_AGENT_ERROR:
    style.status = "ERROR";
    style.status_color = EPD_COLOR_RED;
    break;
  case CODEPULSE_UI_AGENT_LIMITED:
    style.status = "LIMIT";
    style.status_color = EPD_COLOR_RED;
    break;
  case CODEPULSE_UI_AGENT_OFFLINE:
  default:
    break;
  }
  return style;
}

static void draw_agent_icon(epd_canvas_t *canvas,
                            codepulse_ui_agent_type_t type, int y) {
  const int center_y = y + 22;
  if (type == CODEPULSE_UI_AGENT_CLAUDE) {
    epd_canvas_fill_rect(canvas, 17, center_y - 9, 19, 17, EPD_COLOR_RED);
    epd_canvas_fill_rect(canvas, 13, center_y - 5, 4, 9, EPD_COLOR_RED);
    epd_canvas_fill_rect(canvas, 36, center_y - 5, 4, 9, EPD_COLOR_RED);
    epd_canvas_fill_rect(canvas, 20, center_y + 8, 4, 5, EPD_COLOR_RED);
    epd_canvas_fill_rect(canvas, 30, center_y + 8, 4, 5, EPD_COLOR_RED);
    epd_canvas_fill_rect(canvas, 21, center_y - 4, 3, 3, EPD_COLOR_WHITE);
    epd_canvas_fill_rect(canvas, 29, center_y - 4, 3, 3, EPD_COLOR_WHITE);
    draw_line(canvas, 21, center_y - 9, 18, center_y - 13, EPD_COLOR_RED);
    draw_line(canvas, 32, center_y - 9, 35, center_y - 13, EPD_COLOR_RED);
  } else if (type == CODEPULSE_UI_AGENT_CODEX) {
    draw_thick_line(canvas, 26, center_y - 12, 37, center_y - 5, 2,
                    EPD_COLOR_BLACK);
    draw_thick_line(canvas, 37, center_y - 5, 37, center_y + 7, 2,
                    EPD_COLOR_BLACK);
    draw_thick_line(canvas, 37, center_y + 7, 26, center_y + 13, 2,
                    EPD_COLOR_BLACK);
    draw_thick_line(canvas, 26, center_y + 13, 15, center_y + 7, 2,
                    EPD_COLOR_BLACK);
    draw_thick_line(canvas, 15, center_y + 7, 15, center_y - 5, 2,
                    EPD_COLOR_BLACK);
    draw_thick_line(canvas, 15, center_y - 5, 26, center_y - 12, 2,
                    EPD_COLOR_BLACK);
    fill_circle(canvas, 26, center_y + 1, 7, EPD_COLOR_BLACK);
    fill_circle(canvas, 38, center_y + 10, 2, EPD_COLOR_RED);
  } else {
    draw_thick_line(canvas, 16, center_y - 13, 38, center_y + 13, 4,
                    EPD_COLOR_BLACK);
    draw_thick_line(canvas, 38, center_y - 13, 16, center_y + 13, 4,
                    EPD_COLOR_BLACK);
  }
}

static void draw_status_badge(epd_canvas_t *canvas, int x, int y,
                              const agent_style_t *style) {
  const int width = epd_canvas_text_width(style->status, 1) + 8;
  draw_rounded_rect(canvas, x, y, width, 15, style->status_color);
  epd_canvas_draw_text(canvas, x + 4, y + 4, style->status, 1,
                       style->status_color);
}

static void draw_usage_meter(epd_canvas_t *canvas, int x, int label_y,
                             const char *label, int percent, int value_scale,
                             int bar_x, int bar_y, int bar_width) {
  char value[8];
  epd_canvas_draw_text(canvas, x, label_y, label, 1, EPD_COLOR_BLACK);

  if (percent < 0) {
    snprintf(value, sizeof(value), "--%%");
  } else {
    const int clamped = percent > 100 ? 100 : percent;
    snprintf(value, sizeof(value), "%d%%", clamped);
  }
  epd_canvas_draw_text(canvas, x, label_y + 13, value, value_scale,
                       EPD_COLOR_RED);

  draw_rect(canvas, bar_x, bar_y, bar_width, 7, EPD_COLOR_BLACK);
  if (percent >= 0) {
    const int clamped = percent > 100 ? 100 : percent;
    const int fill_width = clamped * (bar_width - 2) / 100;
    if (fill_width > 0) {
      epd_canvas_fill_rect(canvas, bar_x + 1, bar_y + 1, fill_width, 5,
                           EPD_COLOR_RED);
    }
  }
}

static void draw_primary_agent_card(epd_canvas_t *canvas,
                                    const codepulse_ui_agent_t *agent) {
  const int y = 118;
  const agent_style_t style = agent_style(agent);
  draw_rounded_rect(canvas, UI_MARGIN, y, UI_CARD_WIDTH, 53, EPD_COLOR_BLACK);
  draw_agent_icon(canvas, agent->type, y + 4);
  epd_canvas_draw_text(canvas, 46, y + 8, style.name, 2, EPD_COLOR_BLACK);
  draw_status_badge(canvas, 124, y + 7, &style);
  epd_canvas_fill_rect(canvas, 191, y + 7, 1, 39, EPD_COLOR_BLACK);
  draw_usage_meter(canvas, 204, y + 5, "5H", agent->five_hour_percent, 2, 204,
                   y + 39, 74);
  draw_usage_meter(canvas, 298, y + 5, "WEEK", agent->weekly_percent, 2, 298,
                   y + 39, 76);
}

static void draw_compact_agent_card(epd_canvas_t *canvas,
                                    const codepulse_ui_agent_t *agent, int y) {
  const agent_style_t style = agent_style(agent);
  draw_rounded_rect(canvas, UI_MARGIN, y, UI_CARD_WIDTH, 44, EPD_COLOR_BLACK);
  draw_agent_icon(canvas, agent->type, y);
  epd_canvas_draw_text(canvas, 46, y + 12, style.name, 2, EPD_COLOR_BLACK);
  draw_status_badge(canvas, 113, y + 11, &style);
  epd_canvas_fill_rect(canvas, 191, y + 6, 1, 32, EPD_COLOR_BLACK);
  draw_usage_meter(canvas, 204, y + 5, "WEEK", agent->weekly_percent, 2, 263,
                   y + 28, 111);
}

static codepulse_ui_agent_t offline_agent(codepulse_ui_agent_type_t type) {
  return (codepulse_ui_agent_t){
      .type = type,
      .state = CODEPULSE_UI_AGENT_OFFLINE,
      .five_hour_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
      .weekly_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
  };
}

static codepulse_ui_agent_t
agent_for_type(const codepulse_ui_model_t *model,
               codepulse_ui_agent_type_t requested_type) {
  const size_t count = model->agent_count > CODEPULSE_UI_MAX_AGENTS
                           ? CODEPULSE_UI_MAX_AGENTS
                           : model->agent_count;
  for (size_t index = 0; index < count; ++index) {
    if (model->agents[index].type == requested_type) {
      return model->agents[index];
    }
  }
  return offline_agent(requested_type);
}

static void draw_footer(epd_canvas_t *canvas, size_t agent_count) {
  epd_canvas_fill_rect(canvas, UI_MARGIN, 280, UI_CARD_WIDTH, 1,
                       EPD_COLOR_BLACK);

  draw_circle(canvas, 15, 290, 7, EPD_COLOR_BLACK);
  draw_line(canvas, 15, 290, 15, 285, EPD_COLOR_BLACK);
  draw_line(canvas, 15, 290, 19, 292, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 26, 286, "PRESS REFRESH", 1, EPD_COLOR_BLACK);

  draw_rect(canvas, 164, 284, 19, 12, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 169, 296, 9, 2, EPD_COLOR_BLACK);
  char agent_text[16];
  snprintf(agent_text, sizeof(agent_text), "%u AGENTS",
           (unsigned)(agent_count > CODEPULSE_UI_MAX_AGENTS
                          ? CODEPULSE_UI_MAX_AGENTS
                          : agent_count));
  epd_canvas_draw_text(canvas, 190, 286, agent_text, 1, EPD_COLOR_BLACK);

  draw_circle(canvas, 326, 290, 7, EPD_COLOR_BLACK);
  epd_canvas_fill_rect(canvas, 325, 282, 3, 8, EPD_COLOR_WHITE);
  epd_canvas_fill_rect(canvas, 326, 282, 1, 8, EPD_COLOR_BLACK);
  epd_canvas_draw_text(canvas, 338, 286, "HOLD OFF", 1, EPD_COLOR_BLACK);
}

void codepulse_ui_render(epd_canvas_t *canvas,
                         const codepulse_ui_model_t *model) {
  if (canvas == NULL || model == NULL) {
    return;
  }

  epd_canvas_clear(canvas, EPD_COLOR_WHITE);

  draw_brand_mark(canvas);
  epd_canvas_draw_text(canvas, 45, 10, "CODEPULSE", 3, EPD_COLOR_BLACK);
  draw_wifi_icon(canvas, model->wifi_connected);

  char battery_text[8];
  if (model->battery_valid) {
    snprintf(battery_text, sizeof(battery_text), "%u%%",
             model->battery_percent);
  } else {
    snprintf(battery_text, sizeof(battery_text), "--%%");
  }
  const int battery_text_x = 352 - epd_canvas_text_width(battery_text, 2);
  epd_canvas_draw_text(canvas, battery_text_x, 13, battery_text, 2,
                       EPD_COLOR_BLACK);
  draw_battery(canvas, model->battery_valid, model->battery_percent);
  epd_canvas_fill_rect(canvas, UI_MARGIN, 42, UI_CARD_WIDTH, 1,
                       EPD_COLOR_BLACK);

  draw_rounded_rect(canvas, UI_MARGIN, 49, UI_CARD_WIDTH, 62, EPD_COLOR_BLACK);
  draw_thermometer(canvas);
  epd_canvas_draw_text(canvas, 51, 57, "TEMP", 2, EPD_COLOR_BLACK);
  char temperature[16];
  if (model->environment_valid) {
    snprintf(temperature, sizeof(temperature), "%.1fC",
             (double)model->temperature_c);
  } else {
    snprintf(temperature, sizeof(temperature), "--.-C");
  }
  epd_canvas_draw_text(canvas, 51, 79, temperature, 3, EPD_COLOR_RED);

  epd_canvas_fill_rect(canvas, 199, 57, 1, 46, EPD_COLOR_BLACK);
  draw_droplet(canvas);
  epd_canvas_draw_text(canvas, 247, 57, "HUM", 2, EPD_COLOR_BLACK);
  char humidity[16];
  if (model->environment_valid) {
    snprintf(humidity, sizeof(humidity), "%.0f%%RH",
             (double)model->humidity_rh);
  } else {
    snprintf(humidity, sizeof(humidity), "--%%RH");
  }
  epd_canvas_draw_text(canvas, 247, 79, humidity, 3, EPD_COLOR_RED);

  const codepulse_ui_agent_t claude =
      agent_for_type(model, CODEPULSE_UI_AGENT_CLAUDE);
  const codepulse_ui_agent_t codex =
      agent_for_type(model, CODEPULSE_UI_AGENT_CODEX);
  const codepulse_ui_agent_t grok =
      agent_for_type(model, CODEPULSE_UI_AGENT_GROK);
  draw_primary_agent_card(canvas, &claude);
  draw_compact_agent_card(canvas, &codex, 178);
  draw_compact_agent_card(canvas, &grok, 229);
  draw_footer(canvas, model->agent_count);
}
