#pragma once
#include "esp_err.h"

/* Optional new-board audio. Legacy builds are no-op and touch no extra GPIO. */
esp_err_t codepulse_audio_start(void);
/* Immediately prevents new capture/playback and mutes the amplifier before power release. */
void codepulse_audio_stop(void);
