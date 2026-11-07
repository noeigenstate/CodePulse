#pragma once
#include "FreeRTOS.h"
int xTaskNotifyWait(uint32_t entry, uint32_t exit, uint32_t *events, TickType_t wait);
