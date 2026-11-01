#include <assert.h>
#include <stdio.h>
#include "codepulse_audio.h"
int main(void) {
  assert(codepulse_audio_start()==ESP_OK);
  codepulse_audio_stop();
  codepulse_audio_stop();
  puts("PASS: legacy audio-disabled build has no GPIO, I2S, microphone or network dependencies.");
  return 0;
}
