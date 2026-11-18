#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#define PANEL_OTP_BYTES 4096
typedef struct {
  uint8_t status_before, status_partial, status_after, status_final;
  uint8_t revision, dummy[2];
  bool link_verified, otp_repeatable, otp_nonuniform, revision_matches;
  uint8_t otp[PANEL_OTP_BYTES];
} panel_readback_t;
/* Diagnostic only: call once, before any SPI driver is initialized.
 * No booster, display-refresh, LUT/voltage writes or OTP-program commands. */
esp_err_t panel_readback_capture(panel_readback_t *result);
void codepulse_panel_readback_run(uint32_t short_bit, uint32_t long_bit);
