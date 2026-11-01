#pragma once
#include <stdint.h>
#define BOARD_EPD_WIDTH 400
#define BOARD_EPD_HEIGHT 300
#define EPD_CANVAS_BUFFER_SIZE 15000
typedef struct { uint8_t *black; uint8_t *red; } epd_canvas_t;
