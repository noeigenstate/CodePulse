#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "codepulse_ui.h"

/* Network wait is event-driven, not a minimum display interval. The short
 * hold keeps main-task buttons responsive without a second network owner. */
#define CODEPULSE_STATUS_WATCH_MS 1000
#define CODEPULSE_STATUS_REARM_MS 100
#define CODEPULSE_STATUS_RETRY_MS 3000
#define CODEPULSE_SENSOR_SAMPLE_MS 30000
#define CODEPULSE_CONNECTIVITY_SETTLE_MS 3000
#define CODEPULSE_SECONDARY_REFRESH_MIN_MS 900000
#define CODEPULSE_QUOTA_REFRESH_MIN_MS 120000
#define CODEPULSE_SECONDARY_QUIET_MS 60000
#define CODEPULSE_TEMPERATURE_DELTA_C 1.0f
#define CODEPULSE_HUMIDITY_DELTA_RH 5.0f
#define CODEPULSE_BATTERY_DELTA_PERCENT 10

typedef enum {
  DISPLAY_SYNC_NONE,
  DISPLAY_SYNC_RECOVERY,
  DISPLAY_SYNC_LAYOUT,
  DISPLAY_SYNC_QUOTA,
  DISPLAY_SYNC_AGENT_STATE,
  DISPLAY_SYNC_ATTENTION,
  DISPLAY_SYNC_CONNECTIVITY,
  DISPLAY_SYNC_ENVIRONMENT,
  DISPLAY_SYNC_BATTERY,
} display_sync_reason_t;

typedef struct {
  bool attempted;
  bool displayed_valid;
  int64_t last_attempt_ms;
  int64_t last_success_ms;
  int64_t last_secondary_ms;
  int64_t last_quota_ms;
  int64_t last_work_ms;
  codepulse_ui_model_t displayed;
  bool observed;
  bool candidate_connected;
  int64_t connectivity_since_ms;
} display_sync_policy_t;

/* Work state/configuration changes remain immediate. Activity substates share
 * one visible state; quotas and peripheral telemetry have independent pacing.
 * A held content card remains optically static until replaced or interrupted. */
display_sync_reason_t display_sync_evaluate(display_sync_policy_t *policy,
                                            int64_t now_ms,
                                            const codepulse_ui_model_t *model);
void display_sync_record_attempt(display_sync_policy_t *policy, int64_t now_ms,
                                 const codepulse_ui_model_t *model,
                                 bool success);
const char *display_sync_reason_name(display_sync_reason_t reason);

/* Build the actual target: latest semantic states and independently paced
 * quota/peripheral fields. Manual requests may take current readings. */
void display_sync_project(const display_sync_policy_t *policy, int64_t now_ms,
    const codepulse_ui_model_t *model, bool manual, codepulse_ui_model_t *target);
