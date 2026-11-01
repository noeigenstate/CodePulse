#pragma once

#include "esp_err.h"

/*
 * Initializes the GPIO18-driven, 3 kHz magnetic buzzer and leaves it silent.
 */
esp_err_t buzzer_init(void);

/* Plays two bounded short tones for an audible hardware self-test. */
esp_err_t buzzer_play_startup_test(void);

/* Stops PWM immediately and forces the transistor drive low. */
esp_err_t buzzer_stop(void);
