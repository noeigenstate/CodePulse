#pragma once
#include <stdint.h>
typedef uint32_t TickType_t;
#define pdMS_TO_TICKS(ms) ((ms)/10)
#define portMAX_DELAY UINT32_MAX
#define pdTRUE 1
