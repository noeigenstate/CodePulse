#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "codepulse_ui.h"
#include "esp_err.h"

#define CODEPULSE_PROTOCOL_VERSION 1
#define CODEPULSE_REVISION_MAX_BYTES 31
#define CODEPULSE_MAIN_STATE_MAX_BYTES 31

typedef struct {
  codepulse_ui_agent_type_t type;
  codepulse_ui_agent_state_t state;
  int five_hour_percent;
  int weekly_percent;
  bool total_tokens_valid;
  uint64_t total_tokens;
  bool context_used_percent_valid;
  float context_used_percent;
} codepulse_remote_agent_t;

typedef struct {
  codepulse_ambient_t ambient;
  codepulse_display_config_t display;
  codepulse_ui_thread_t threads[CODEPULSE_UI_MAX_THREADS];
  size_t thread_count;
  unsigned thread_total;
  uint64_t weekly_resets[CODEPULSE_UI_MAX_AGENTS];
  bool valid;
  char revision[CODEPULSE_REVISION_MAX_BYTES + 1];
  char main_state[CODEPULSE_MAIN_STATE_MAX_BYTES + 1];
  codepulse_remote_agent_t agents[CODEPULSE_UI_MAX_AGENTS];
  size_t agent_count;
} codepulse_remote_status_t;

void codepulse_remote_status_reset(codepulse_remote_status_t *status);

/* Parses and validates one complete /api/v1/device/status JSON response. */
esp_err_t codepulse_protocol_parse(const char *json, size_t length,
                                   codepulse_remote_status_t *status);

void codepulse_remote_apply(const codepulse_remote_status_t *remote,
                            codepulse_ui_model_t *model);
