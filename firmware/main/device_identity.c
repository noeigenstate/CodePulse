#include "device_identity.h"

#include <stdio.h>
#include <string.h>

#include "board_pins.h"
#include "esp_app_desc.h"
#include "esp_mac.h"

esp_err_t
codepulse_device_identity_read(codepulse_device_identity_t *identity) {
  if (identity == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  memset(identity, 0, sizeof(*identity));

  uint8_t mac[6] = {0};
  const esp_err_t err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
  if (err != ESP_OK) {
    return err;
  }

  const int id_length =
      snprintf(identity->device_id, sizeof(identity->device_id),
               "codepulse-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2],
               mac[3], mac[4], mac[5]);
  if (id_length < 0 || (size_t)id_length >= sizeof(identity->device_id)) {
    memset(identity, 0, sizeof(*identity));
    return ESP_ERR_INVALID_SIZE;
  }

  const esp_app_desc_t *description = esp_app_get_description();
  const size_t version_length =
      strnlen(description->version, sizeof(description->version));
  if (version_length > CODEPULSE_FIRMWARE_VERSION_MAX_BYTES) {
    memset(identity, 0, sizeof(*identity));
    return ESP_ERR_INVALID_SIZE;
  }
  memcpy(identity->firmware_version, description->version, version_length + 1);
  identity->hardware_revision = BOARD_HW_REV;
  return ESP_OK;
}
