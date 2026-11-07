/* Browser/native adapter only. Uses the production parser, projection, fonts
 * and renderer; it cannot drive a panel, open a port, or write configuration. */
#include "codepulse_protocol.h"
#include "display_text.h"
#include "quiet_dashboard.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char input[65536];
static uint8_t black[EPD_CANVAS_BUFFER_SIZE], red[EPD_CANVAS_BUFFER_SIZE];
char *preview_input(void) { return input; }
unsigned preview_capacity(void) { return sizeof(input); }
uint8_t *preview_frame(void) { return black; }
uint8_t *preview_red_frame(void) { return red; }
unsigned preview_size(void) { return sizeof(black); }
int preview_render(unsigned length, int sensors, float temperature,
                   float humidity, int battery, int wifi) {
  if (length == 0 || length >= sizeof(input)) return 1;
  input[length] = 0;
  codepulse_remote_status_t remote;
  if (codepulse_protocol_parse(input, length, &remote) != ESP_OK) return 2;
  if (!display_text_init()) return 3;
  codepulse_ui_model_t model = {
    .environment_valid = sensors != 0,
    .temperature_c = temperature, .humidity_rh = humidity,
    .battery_valid = battery >= 0 && battery <= 100,
    .battery_percent = (uint8_t)(battery >= 0 && battery <= 100 ? battery : 0),
    /* 0 means unknown preview telemetry; -1 explicitly simulates stale data. */
    .wifi_connected = wifi > 0,
    .work_status_stale = wifi < 0,
  };
  codepulse_remote_apply(&remote, &model);
  epd_canvas_t canvas = { black, red };
  quiet_dashboard_render(&canvas, &model);
  return 0;
}
/* Link-only guards: no refresh call is exported or invoked by this adapter. */
esp_err_t epd_ssd1683_refresh(const epd_canvas_t *c, uint32_t *ms) {
  (void)c; (void)ms; return ESP_FAIL;
}
esp_err_t epd_quiet_refresh(const epd_canvas_t *c, const uint8_t *old,
                          size_t n, unsigned y, unsigned h,
                          epd_quiet_metrics_t *metrics) {
  (void)c; (void)old; (void)n; (void)y; (void)h; (void)metrics;
  return ESP_FAIL;
}
#ifdef PREVIEW_NATIVE
int main(int argc, char **argv) {
  if (argc != 3 && argc != 4 && argc != 8 && argc != 9) return 1;
  const int sensors = argc >= 8;
  FILE *f = fopen(argv[1], "rb");
  if (!f) return 2;
  size_t n = fread(input, 1, sizeof(input), f);
  fclose(f);
  if (preview_render((unsigned)n, sensors ? atoi(argv[3]) : 0,
                     sensors ? (float)atof(argv[4]) : 0,
                     sensors ? (float)atof(argv[5]) : 0,
                     sensors ? atoi(argv[6]) : -1,
                     sensors ? atoi(argv[7]) : 0)) return 3;
  f = fopen(argv[2], "wb");
  if (!f) return 4;
  fwrite(black, 1, sizeof(black), f);
  fclose(f);
  if (argc == 4 || argc == 9) {
    f = fopen(argv[argc - 1], "wb");
    if (!f) return 4;
    fwrite(red, 1, sizeof(red), f);
    fclose(f);
  }
  return 0;
}
#endif
