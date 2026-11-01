#pragma once

#include <stdint.h>

#include "board_pins.h"

#define EPD_CANVAS_BUFFER_SIZE ((BOARD_EPD_WIDTH * BOARD_EPD_HEIGHT) / 8)

typedef enum {
  EPD_COLOR_WHITE,
  EPD_COLOR_BLACK,
  EPD_COLOR_RED,
} epd_color_t;

typedef struct {
  /* Legacy controller encoding: a cleared bit selects that plane's pigment. */
  uint8_t *black;
  uint8_t *red;
} epd_canvas_t;

void epd_canvas_clear(epd_canvas_t *canvas, epd_color_t color);
void epd_canvas_pixel(epd_canvas_t *canvas, int x, int y, epd_color_t color);
void epd_canvas_fill_rect(epd_canvas_t *canvas, int x, int y, int width,
                          int height, epd_color_t color);
void epd_canvas_draw_text(epd_canvas_t *canvas, int x, int y, const char *text,
                          int scale, epd_color_t color);
int epd_canvas_text_width(const char *text, int scale);
