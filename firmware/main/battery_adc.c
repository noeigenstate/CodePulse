#include "battery_adc.h"

#include <stddef.h>
#include <stdint.h>

#include "board_pins.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "soc/adc_channel.h"

#define BATTERY_ADC_UNIT ADC_UNIT_1
#define BATTERY_ADC_CHANNEL ADC_CHANNEL_7
#define BATTERY_ADC_ATTEN ADC_ATTEN_DB_6
#define BATTERY_ADC_SAMPLE_COUNT 32
#define BATTERY_ADC_SAMPLE_INTERVAL_US 200
#define BATTERY_DIVIDER_MULTIPLIER 3U
#define BATTERY_MIN_VALID_MV 2500U
#define BATTERY_MAX_VALID_MV 4500U
#define BATTERY_UNCALIBRATED_FULL_SCALE_MV 1750U
#define BATTERY_ADC_MAX_RAW 4095U

static const char *TAG = "battery_adc";
static adc_oneshot_unit_handle_t s_adc_handle;
static adc_cali_handle_t s_cali_handle;
static bool s_initialized;

_Static_assert(ADC1_CHANNEL_7_GPIO_NUM == PIN_BAT_ADC,
               "battery ADC channel must match the GPIO8 flywire");

typedef struct {
  uint16_t voltage_mv;
  uint8_t percent;
} battery_soc_point_t;

/* Approximate single-cell Li-ion open-circuit curve; loaded readings vary. */
static const battery_soc_point_t s_soc_curve[] = {
    {4200, 100}, {4150, 95}, {4100, 90}, {4050, 85}, {4000, 80},
    {3950, 75},  {3900, 70}, {3850, 60}, {3800, 50}, {3750, 40},
    {3700, 30},  {3650, 20}, {3550, 10}, {3400, 5},  {3200, 0},
};

static uint8_t estimate_percent(uint32_t voltage_mv) {
  if (voltage_mv >= s_soc_curve[0].voltage_mv) {
    return s_soc_curve[0].percent;
  }

  const size_t last = sizeof(s_soc_curve) / sizeof(s_soc_curve[0]) - 1;
  if (voltage_mv <= s_soc_curve[last].voltage_mv) {
    return s_soc_curve[last].percent;
  }

  for (size_t i = 1; i <= last; ++i) {
    const battery_soc_point_t high = s_soc_curve[i - 1];
    const battery_soc_point_t low = s_soc_curve[i];
    if (voltage_mv >= low.voltage_mv) {
      const uint32_t voltage_span = high.voltage_mv - low.voltage_mv;
      const uint32_t percent_span = high.percent - low.percent;
      const uint32_t offset = voltage_mv - low.voltage_mv;
      return (uint8_t)(low.percent +
                       (offset * percent_span + voltage_span / 2) /
                           voltage_span);
    }
  }

  return 0;
}

static void delete_adc_unit(void) {
  if (s_adc_handle != NULL) {
    adc_oneshot_del_unit(s_adc_handle);
    s_adc_handle = NULL;
  }
}

esp_err_t battery_adc_init(void) {
  if (s_initialized) {
    return ESP_OK;
  }

  const adc_oneshot_unit_init_cfg_t unit_config = {
      .unit_id = BATTERY_ADC_UNIT,
      .ulp_mode = ADC_ULP_MODE_DISABLE,
  };
  esp_err_t err = adc_oneshot_new_unit(&unit_config, &s_adc_handle);
  if (err != ESP_OK) {
    return err;
  }

  const adc_oneshot_chan_cfg_t channel_config = {
      .atten = BATTERY_ADC_ATTEN,
      .bitwidth = ADC_BITWIDTH_DEFAULT,
  };
  err = adc_oneshot_config_channel(s_adc_handle, BATTERY_ADC_CHANNEL,
                                   &channel_config);
  if (err != ESP_OK) {
    delete_adc_unit();
    return err;
  }

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
  const adc_cali_curve_fitting_config_t calibration_config = {
      .unit_id = BATTERY_ADC_UNIT,
      .chan = BATTERY_ADC_CHANNEL,
      .atten = BATTERY_ADC_ATTEN,
      .bitwidth = ADC_BITWIDTH_DEFAULT,
  };
  s_cali_handle = NULL;
  err =
      adc_cali_create_scheme_curve_fitting(&calibration_config, &s_cali_handle);
  if (err == ESP_ERR_NOT_SUPPORTED) {
    s_cali_handle = NULL;
    ESP_LOGW(TAG,
             "ADC calibration eFuse data unavailable; using nominal scale");
  } else if (err != ESP_OK) {
    delete_adc_unit();
    return err;
  }
#else
  ESP_LOGW(TAG, "ADC calibration scheme unavailable; using nominal scale");
#endif

  s_initialized = true;
  ESP_LOGI(TAG, "ready on GPIO8 / ADC1_CH7, divider=200k/100k calibrated=%s",
           s_cali_handle != NULL ? "true" : "false");
  return ESP_OK;
}

esp_err_t battery_adc_read(battery_sample_t *sample) {
  if (sample == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  *sample = (battery_sample_t){0};

  if (!s_initialized || s_adc_handle == NULL) {
    return ESP_ERR_INVALID_STATE;
  }

  /* Discard one conversion after the channel may have been idle for a while. */
  int raw = 0;
  esp_err_t err = adc_oneshot_read(s_adc_handle, BATTERY_ADC_CHANNEL, &raw);
  if (err != ESP_OK) {
    return err;
  }

  int64_t raw_sum = 0;
  for (int i = 0; i < BATTERY_ADC_SAMPLE_COUNT; ++i) {
    err = adc_oneshot_read(s_adc_handle, BATTERY_ADC_CHANNEL, &raw);
    if (err != ESP_OK) {
      return err;
    }
    raw_sum += raw;
    esp_rom_delay_us(BATTERY_ADC_SAMPLE_INTERVAL_US);
  }

  const int average_raw = (int)((raw_sum + BATTERY_ADC_SAMPLE_COUNT / 2) /
                                BATTERY_ADC_SAMPLE_COUNT);
  int divider_mv = 0;
  if (s_cali_handle != NULL) {
    err = adc_cali_raw_to_voltage(s_cali_handle, average_raw, &divider_mv);
    if (err != ESP_OK) {
      return err;
    }
  } else {
    divider_mv =
        (int)(((uint32_t)average_raw * BATTERY_UNCALIBRATED_FULL_SCALE_MV +
               BATTERY_ADC_MAX_RAW / 2) /
              BATTERY_ADC_MAX_RAW);
  }

  sample->raw = average_raw;
  sample->calibrated = s_cali_handle != NULL;
  sample->voltage_mv = (uint32_t)divider_mv * BATTERY_DIVIDER_MULTIPLIER;
  sample->percent = estimate_percent(sample->voltage_mv);

  if (sample->voltage_mv < BATTERY_MIN_VALID_MV ||
      sample->voltage_mv > BATTERY_MAX_VALID_MV) {
    return ESP_ERR_INVALID_RESPONSE;
  }

  return ESP_OK;
}
