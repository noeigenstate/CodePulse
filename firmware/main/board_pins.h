#pragma once

#include "driver/gpio.h"

#define BOARD_HW_REV 1

#define PIN_EPD_BUSY GPIO_NUM_4
#define PIN_EPD_RST GPIO_NUM_5
#define PIN_EPD_DC GPIO_NUM_6
#define PIN_EPD_CS GPIO_NUM_7
#define PIN_PWR_HOLD GPIO_NUM_9
#define PIN_BUTTON GPIO_NUM_10
#define PIN_I2C_SDA GPIO_NUM_11
#define PIN_I2C_SCL GPIO_NUM_12
#define PIN_STATUS_LED GPIO_NUM_15
#define PIN_EPD_SCLK GPIO_NUM_16
#define PIN_EPD_MOSI GPIO_NUM_17
#define PIN_BUZZER GPIO_NUM_18
#define PIN_USB_DN GPIO_NUM_19
#define PIN_USB_DP GPIO_NUM_20

/*
 * Board1 V1.0 originally routes ADC_BAT to non-ADC GPIO42. This unit has a
 * direct flywire from that net to GPIO8 (ADC1_CH7); both pads must stay inputs.
 */
#define PIN_BAT_ADC_ORIGINAL GPIO_NUM_42
#define PIN_BAT_ADC GPIO_NUM_8
#define BOARD_HAS_VALID_BAT_ADC 1

/* Confirmed panel: legacy Waveshare WFT0420CZ15, 400x300 B/W/R. */
#define BOARD_EPD_PHYSICAL_REFRESH_ENABLED 1
#define BOARD_EPD_WIDTH 400
#define BOARD_EPD_HEIGHT 300
