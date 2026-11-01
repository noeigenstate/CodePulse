#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define CODEPULSE_USB_PROVISIONING_PROTOCOL_VERSION 1
#define CODEPULSE_USB_FRAME_PREFIX "CP1 "

typedef enum {
  CODEPULSE_USB_RUNTIME_UNPROVISIONED,
  CODEPULSE_USB_RUNTIME_APPLYING,
  CODEPULSE_USB_RUNTIME_WIFI_ERROR,
  CODEPULSE_USB_RUNTIME_DESKTOP_UNREACHABLE,
  CODEPULSE_USB_RUNTIME_READY,
} codepulse_usb_runtime_state_t;

/*
 * Starts the newline-delimited USB provisioning service. After a successful
 * NVS commit, notification_bit is posted to notification_task.
 */
esp_err_t codepulse_usb_provisioning_start(TaskHandle_t notification_task,
                                           uint32_t notification_bit);

/* Thread-safe runtime status exposed by the getStatus USB operation. */
void codepulse_usb_provisioning_set_runtime_state(
    codepulse_usb_runtime_state_t state);

/* Increments after every successful NVS commit; resets to zero on boot. */
uint32_t codepulse_usb_provisioning_configuration_generation(void);
