#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include "resolution_probe.h"
#include "epd_ssd1683.h"
#include "freertos/task.h"
static uint8_t black[15000], red[15000];
static int init_error, refresh_error, init_count, refresh_count, wait_count;
static uint32_t signals[4];
esp_err_t epd_ssd1683_init(void) { ++init_count; return init_error; }
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *canvas, uint32_t *duration) {
  ++refresh_count;
  assert(canvas->black == black && canvas->red == red);
  assert(canvas->black[0] == 0 && canvas->red[0] == 255);
  *duration = 1;
  return refresh_error;
}
int xTaskNotifyWait(uint32_t entry, uint32_t exit, uint32_t *events, TickType_t wait) {
  assert(entry == 0 && exit == UINT32_MAX && wait_count < 4);
  assert(wait == (wait_count == 0 ? 0 : portMAX_DELAY));
  *events = signals[wait_count++];
  return pdTRUE;
}
static bool run(int init, int refresh, uint32_t during, uint32_t next, uint32_t last) {
  init_error = init; refresh_error = refresh;
  init_count = refresh_count = wait_count = 0;
  signals[0] = during; signals[1] = next; signals[2] = last;
  epd_canvas_t c = {.black = black, .red = red};
  return codepulse_resolution_probe_run(&c, 1, 2);
}
int main(void) {
  assert(run(ESP_OK, ESP_OK, 0, 1, 0));
  assert(init_count == 1 && refresh_count == 1 && wait_count == 2);
  assert(!run(ESP_OK, ESP_OK, 0, 2, 0));
  assert(refresh_count == 1 && wait_count == 2);
  assert(!run(ESP_OK, ESP_OK, 2, 1, 0));
  assert(refresh_count == 1 && wait_count == 1);
  assert(run(ESP_OK, ESP_OK, 1, 1, 0));
  assert(refresh_count == 1 && wait_count == 2);
  assert(!run(ESP_ERR_INVALID_RESPONSE, ESP_OK, 0, 1, 0));
  assert(init_count == 1 && refresh_count == 0 && wait_count == 0);
  assert(!run(ESP_OK, ESP_ERR_INVALID_RESPONSE, 0, 1, 0));
  assert(refresh_count == 1 && wait_count == 0);
  assert(run(ESP_OK, ESP_OK, 0, 4, 1));
  assert(refresh_count == 1 && wait_count == 3);
  puts("PASS: one-shot refresh, short return, long shutdown, waveform input discard and no error retries");
  return 0;
}
