#pragma once
#include "epd_canvas.h"
#include <stdbool.h>

typedef enum {
  DISPLAY_BODY,
  DISPLAY_TITLE,
  DISPLAY_DENSE_TITLE,
  DISPLAY_BADGE,
  DISPLAY_NUMBER,
  DISPLAY_USAGE_NUMBER, /* Native Noto Sans Bold40; complete SC16 fallback. */
  DISPLAY_SMALL_BOLD,
  DISPLAY_META,  /* Noto SC14 / Noto Sans Bold16, complete repertoire. */
  DISPLAY_BRAND, /* Native Latin12 with the complete SC14 fallback. */
  DISPLAY_USAGE_TITLE, /* SC16 / native Latin20. */
  DISPLAY_STATE, /* Complete SC14 / native Latin16. */
  DISPLAY_SUMMARY, /* Complete SC14 / native Latin14. */
  DISPLAY_MICRO, /* Native calendar12 / Latin12; complete SC14 fallback. */
  DISPLAY_DATE, /* Complete SC16 fallback / native Latin24 dates. */
  DISPLAY_FONT_COUNT
} display_font_t;

/* Immutable 1-bit atlas with original bearings and integer advances, expanded once into PSRAM. */
bool display_text_init(void);
int display_font_height(display_font_t font);
typedef enum { DISPLAY_LEFT, DISPLAY_CENTER, DISPLAY_RIGHT } display_align_t;
typedef struct { int left, top, right, bottom, advance; } display_text_bounds_t;
display_text_bounds_t display_font_bounds(display_font_t font, const char *text);
/* Baseline-anchored runs. Alignment applies to the whole ink envelope. */
void display_font_run(epd_canvas_t *c, display_font_t font, int x, int baseline,
                      const char *text, display_align_t align, epd_color_t color);
int display_font_block(epd_canvas_t *c, display_font_t font, int x, int baseline,
                        int width, int lines, int step, const char *text,
                        epd_color_t color);
int display_font_width(display_font_t font, const char *text);
/* Legacy probe/source compatibility only; current pages use native strikes. */
void display_font_run_scaled(epd_canvas_t *c, display_font_t font, int x, int baseline,
                             const char *text, display_align_t align, epd_color_t color, int scale);
/* True only if every ink pixel of this run is inside the same integer circle. */
bool display_font_circle_fit(display_font_t font, int x, int baseline, const char *text,
                             display_align_t align, int cx, int cy, int diameter);
static inline bool display_circle_pixel(int x, int y, int cx, int cy, int diameter) {
  int dx = 2 * (x - (cx - diameter / 2)) + 1 - diameter;
  int dy = 2 * (y - (cy - diameter / 2)) + 1 - diameter;
  return dx * dx + dy * dy <= diameter * diameter;
}
int display_font_lines(display_font_t font, int width, int limit,
                       const char *text);
void display_font_text(epd_canvas_t *c, display_font_t font, int x, int y,
                       int width, int lines, const char *text,
                       epd_color_t color);
int display_text_width(const char *text);
void display_text(epd_canvas_t *c, int x, int y, int width, int lines,
                  const char *text, epd_color_t color);
void display_droplet(epd_canvas_t *c, int x, int y);
