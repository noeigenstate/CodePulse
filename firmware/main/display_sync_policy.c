#include "display_sync_policy.h"

#include <math.h>
#include <string.h>

static codepulse_ui_agent_t agent_for_type(const codepulse_ui_model_t *model,
                                           codepulse_ui_agent_type_t type) {
  const size_t count = model->agent_count > CODEPULSE_UI_MAX_AGENTS
                           ? CODEPULSE_UI_MAX_AGENTS
                           : model->agent_count;
  for (size_t index = 0; index < count; ++index) {
    if (model->agents[index].type == type) {
      return model->agents[index];
    }
  }
  return (codepulse_ui_agent_t){
      .type = type,
      .state = CODEPULSE_UI_AGENT_OFFLINE,
      .five_hour_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
      .weekly_percent = CODEPULSE_UI_PERCENT_UNKNOWN,
  };
}

static bool elapsed(int64_t now_ms, int64_t since_ms, int64_t interval_ms) {
  return now_ms >= since_ms && now_ms - since_ms >= interval_ms;
}

static bool same_config(const codepulse_display_config_t *a,
                        const codepulse_display_config_t *b) {
  return a->valid == b->valid &&
         (!a->valid || (a->hud == b->hud && a->remaining == b->remaining &&
                        a->show_quota == b->show_quota &&
                        a->show_environment == b->show_environment && a->inverted == b->inverted &&
                        a->agent_mask == b->agent_mask && a->page == b->page));
}

/* Compare visible identities/titles, not state timestamps or transient details.
 */
static bool same_threads(const codepulse_ui_model_t *a,
                         const codepulse_ui_model_t *b) {
  if (a->thread_count != b->thread_count || a->thread_total != b->thread_total)
    return false;
  for (size_t i = 0; i < a->thread_count && i < CODEPULSE_UI_MAX_THREADS; ++i)
    if (strcmp(a->threads[i].id, b->threads[i].id) ||
        strcmp(a->threads[i].title, b->threads[i].title) ||
        a->threads[i].type != b->threads[i].type)
      return false;
  return true;
}

static bool visible_provider(const codepulse_ui_model_t *m, size_t type) {
  if (!m->display.valid)
    return true;
  if (!(m->display.agent_mask & (1u << type)))
    return false;
  if (!m->display.hud)
    return true;
  if (!m->display.show_quota)
    return false;
  return true; /* The HUD footer always shows all selected accounts. */
}

static bool attention(codepulse_ui_agent_state_t state) {
  return state == CODEPULSE_UI_AGENT_WAITING || state == CODEPULSE_UI_AGENT_DONE ||
         state == CODEPULSE_UI_AGENT_ERROR || state == CODEPULSE_UI_AGENT_LIMITED;
}

static bool same_visible_reason(const codepulse_ui_thread_t *a,
                                const codepulse_ui_thread_t *b) {
  if (codepulse_thread_level(a) == CODEPULSE_LEVEL_ACTIVE &&
      codepulse_thread_level(b) == CODEPULSE_LEVEL_ACTIVE) return true;
  return !strcmp(a->state_reason, b->state_reason);
}

static bool quota_ready(const display_sync_policy_t *p, int64_t now,
                        const codepulse_ui_model_t *m) {
  if (!m->display.valid || elapsed(now, p->last_quota_ms, CODEPULSE_QUOTA_REFRESH_MIN_MS)) return true;
  for (unsigned i = 0; i < CODEPULSE_UI_MAX_AGENTS; i++) {
    if (!visible_provider(m, i)) continue;
    codepulse_ui_agent_t a = agent_for_type(m, (codepulse_ui_agent_type_t)i);
    codepulse_ui_agent_t b = agent_for_type(&p->displayed, (codepulse_ui_agent_type_t)i);
    if ((a.weekly_percent >= 0 && b.weekly_percent < 0) ||
        (a.weekly_percent == 100 && b.weekly_percent != 100) ||
        (i == CODEPULSE_UI_AGENT_CLAUDE &&
         ((a.five_hour_percent >= 0 && b.five_hour_percent < 0) ||
          (a.five_hour_percent == 100 && b.five_hour_percent != 100)))) return true;
  }
  return false;
}

static bool thread_change(const display_sync_policy_t *p,
                          const codepulse_ui_model_t *m, bool urgent_only) {
  if (!urgent_only && !same_threads(&p->displayed, m)) return true;
  for (size_t i = 0; i < m->thread_count; i++) {
    const codepulse_ui_thread_t *shown = NULL;
    for (size_t j = 0; j < p->displayed.thread_count; j++)
      if (!strcmp(m->threads[i].id, p->displayed.threads[j].id)) {
        shown = &p->displayed.threads[j];
        break;
      }
    if ((!shown || shown->state != m->threads[i].state ||
         codepulse_thread_level(shown) != codepulse_thread_level(&m->threads[i]) ||
         !same_visible_reason(shown, &m->threads[i])) &&
        (!urgent_only || codepulse_thread_attention(&m->threads[i]))) return true;
  }
  return false;
}

static void observe(display_sync_policy_t *p, int64_t now,
                    const codepulse_ui_model_t *m) {
  if (!p->observed || p->candidate_connected != m->wifi_connected) {
    p->candidate_connected = m->wifi_connected;
    p->connectivity_since_ms = now;
  }
  p->observed = true;
}

display_sync_reason_t display_sync_evaluate(display_sync_policy_t *policy,
                                            int64_t now_ms,
                                            const codepulse_ui_model_t *model) {
  observe(policy, now_ms, model);
  /* A failed optical OLD baseline is unsafe to reuse. Runtime shuts down;
   * this latch also prevents any caller from silently retrying/full flashing. */
  if (policy->attempted && (!policy->displayed_valid || now_ms < policy->last_attempt_ms)) {
    return DISPLAY_SYNC_NONE;
  }
  if (!policy->displayed_valid) {
    return DISPLAY_SYNC_RECOVERY;
  }

  if (strcmp(model->ambient_id, policy->displayed.ambient_id))
    return DISPLAY_SYNC_LAYOUT;
  if (!same_config(&model->display, &policy->displayed.display))
    return DISPLAY_SYNC_LAYOUT;
  /* Host attention arbitration removes ambient before it reaches this layer.
   * A retained card ignores unrelated work/quotas/sensors while its ID is held. */
  if (model->ambient && model->ambient_id[0]) return DISPLAY_SYNC_NONE;
  if (model->display.valid && model->display.hud) {
    if (thread_change(policy, model, true)) return DISPLAY_SYNC_ATTENTION;
    if (thread_change(policy, model, false)) return DISPLAY_SYNC_AGENT_STATE;
  }
  if (!model->display.valid) {
    bool changed = false;
    for (size_t i = 0; i < CODEPULSE_UI_MAX_AGENTS; ++i) {
      const codepulse_ui_agent_t current = agent_for_type(model, (codepulse_ui_agent_type_t)i);
      if (current.state != agent_for_type(&policy->displayed, (codepulse_ui_agent_type_t)i).state) {
        if (attention(current.state)) return DISPLAY_SYNC_ATTENTION;
        changed = true;
      }
    }
    if (changed) return DISPLAY_SYNC_AGENT_STATE;
  }
  for (size_t index = 0; index < CODEPULSE_UI_MAX_AGENTS; ++index) {
    if (!visible_provider(model, index))
      continue;
    const codepulse_ui_agent_type_t type = (codepulse_ui_agent_type_t)index;
    const codepulse_ui_agent_t current = agent_for_type(model, type);
    const codepulse_ui_agent_t shown = agent_for_type(&policy->displayed, type);
    // Claude draws both windows in work cards/footer and usage; others draw weekly.
    if (quota_ready(policy, now_ms, model) &&
        (current.weekly_percent != shown.weekly_percent ||
         (type == CODEPULSE_UI_AGENT_CLAUDE &&
          current.five_hour_percent != shown.five_hour_percent) ||
         (model->display.valid && !model->display.hud &&
          type != CODEPULSE_UI_AGENT_CLAUDE &&
          model->weekly_resets[type] != policy->displayed.weekly_resets[type]))) {
      return DISPLAY_SYNC_QUOTA;
    }
  }
  if ((model->wifi_connected != policy->displayed.wifi_connected ||
       model->work_status_stale != policy->displayed.work_status_stale) &&
      elapsed(now_ms, policy->connectivity_since_ms,
              CODEPULSE_CONNECTIVITY_SETTLE_MS)) {
    return DISPLAY_SYNC_CONNECTIVITY;
  }

  // Environmental/battery updates piggyback on agent refreshes. A large change
  // may trigger its own refresh only after the slower secondary interval.
  if (!elapsed(now_ms, policy->last_secondary_ms, CODEPULSE_SECONDARY_REFRESH_MIN_MS) ||
      !elapsed(now_ms, policy->last_work_ms, CODEPULSE_SECONDARY_QUIET_MS)) {
    return DISPLAY_SYNC_NONE;
  }
  if ((!model->display.valid || model->display.show_environment) &&
      (model->environment_valid != policy->displayed.environment_valid ||
       (model->environment_valid &&
        (fabsf(model->temperature_c - policy->displayed.temperature_c) >=
             CODEPULSE_TEMPERATURE_DELTA_C ||
         fabsf(model->humidity_rh - policy->displayed.humidity_rh) >=
             CODEPULSE_HUMIDITY_DELTA_RH)))) {
    return DISPLAY_SYNC_ENVIRONMENT;
  }
  const int battery_delta =
      (int)model->battery_percent - (int)policy->displayed.battery_percent;
  if (model->battery_valid != policy->displayed.battery_valid ||
      (model->battery_valid &&
       (battery_delta >= CODEPULSE_BATTERY_DELTA_PERCENT ||
        battery_delta <= -CODEPULSE_BATTERY_DELTA_PERCENT))) {
    return DISPLAY_SYNC_BATTERY;
  }
  return DISPLAY_SYNC_NONE;
}

void display_sync_record_attempt(display_sync_policy_t *policy, int64_t now_ms,
                                 const codepulse_ui_model_t *model,
                                 bool success) {
  policy->attempted = true;
  policy->last_attempt_ms = now_ms;
  if (success &&
      (!policy->displayed_valid ||
       model->environment_valid != policy->displayed.environment_valid ||
       model->temperature_c != policy->displayed.temperature_c ||
       model->humidity_rh != policy->displayed.humidity_rh ||
       model->battery_valid != policy->displayed.battery_valid ||
       model->battery_percent != policy->displayed.battery_percent))
    policy->last_secondary_ms = now_ms;
  if (success) {
    bool quota_changed = !policy->displayed_valid;
    for (unsigned i = 0; i < CODEPULSE_UI_MAX_AGENTS; i++) {
      codepulse_ui_agent_t a = agent_for_type(model, (codepulse_ui_agent_type_t)i);
      codepulse_ui_agent_t b = agent_for_type(&policy->displayed, (codepulse_ui_agent_type_t)i);
      if (a.weekly_percent != b.weekly_percent || a.five_hour_percent != b.five_hour_percent ||
          model->weekly_resets[i] != policy->displayed.weekly_resets[i]) quota_changed = true;
    }
    if (quota_changed) policy->last_quota_ms = now_ms;
    if (!policy->displayed_valid || !same_threads(model, &policy->displayed) ||
        thread_change(policy, model, false)) policy->last_work_ms = now_ms;
  }
  policy->displayed_valid = success;
  if (success) {
    policy->displayed = *model;
    policy->last_success_ms = now_ms;
    if (!policy->observed)
      observe(policy, now_ms, model);
  }
}

const char *display_sync_reason_name(display_sync_reason_t reason) {
  switch (reason) {
  case DISPLAY_SYNC_ATTENTION:
    return "attention";
  case DISPLAY_SYNC_LAYOUT:
    return "layout";
  case DISPLAY_SYNC_RECOVERY:
    return "recovery";
  case DISPLAY_SYNC_QUOTA:
    return "quota";
  case DISPLAY_SYNC_AGENT_STATE:
    return "agent_state";
  case DISPLAY_SYNC_CONNECTIVITY:
    return "connectivity";
  case DISPLAY_SYNC_ENVIRONMENT:
    return "environment";
  case DISPLAY_SYNC_BATTERY:
    return "battery";
  case DISPLAY_SYNC_NONE:
  default:
    return "none";
  }
}

void display_sync_project(const display_sync_policy_t *p, int64_t now,
                          const codepulse_ui_model_t *m, bool manual,
                          codepulse_ui_model_t *out) {
  *out = *m;
  if (manual || !p->displayed_valid ||
      !same_config(&m->display, &p->displayed.display) ||
      strcmp(m->ambient_id, p->displayed.ambient_id)) return;
  if (m->ambient && m->ambient_id[0]) {
    *out = p->displayed;
    out->ambient = m->ambient; /* Never retain a borrowed network buffer pointer. */
    return;
  }
  /* Tool/detail chatter alone never refreshes or widens another update.
   * A changed title/state/identity is displayed immediately, including detail. */
  if (same_config(&m->display, &p->displayed.display) && same_threads(m, &p->displayed))
    for (size_t i = 0; i < m->thread_count; i++)
      if (m->threads[i].state == p->displayed.threads[i].state &&
          codepulse_thread_level(&m->threads[i]) == codepulse_thread_level(&p->displayed.threads[i]) &&
          same_visible_reason(&m->threads[i], &p->displayed.threads[i]))
        memcpy(out->threads[i].detail, p->displayed.threads[i].detail,
               sizeof(out->threads[i].detail));
  out->agent_count = CODEPULSE_UI_MAX_AGENTS;
  for (size_t i = 0; i < CODEPULSE_UI_MAX_AGENTS; ++i)
    out->agents[i] = agent_for_type(m, (codepulse_ui_agent_type_t)i);
  if (!quota_ready(p, now, m)) {
    for (unsigned i = 0; i < CODEPULSE_UI_MAX_AGENTS; i++) {
      codepulse_ui_agent_t shown = agent_for_type(&p->displayed, (codepulse_ui_agent_type_t)i);
      out->agents[i].five_hour_percent = shown.five_hour_percent;
      out->agents[i].weekly_percent = shown.weekly_percent;
      out->weekly_resets[i] = p->displayed.weekly_resets[i];
    }
  }
  if (!elapsed(now, p->connectivity_since_ms, CODEPULSE_CONNECTIVITY_SETTLE_MS)) {
    out->wifi_connected = p->displayed.wifi_connected;
    out->work_status_stale = p->displayed.work_status_stale;
  }
  const bool secondary_due =
      elapsed(now, p->last_secondary_ms, CODEPULSE_SECONDARY_REFRESH_MIN_MS) &&
      elapsed(now, p->last_work_ms, CODEPULSE_SECONDARY_QUIET_MS) &&
      !thread_change(p, m, false);
  const bool environment_changed =
      m->environment_valid != p->displayed.environment_valid ||
      (m->environment_valid &&
       (fabsf(m->temperature_c - p->displayed.temperature_c) >=
            CODEPULSE_TEMPERATURE_DELTA_C ||
        fabsf(m->humidity_rh - p->displayed.humidity_rh) >=
            CODEPULSE_HUMIDITY_DELTA_RH));
  if (!secondary_due || !environment_changed) {
    out->environment_valid = p->displayed.environment_valid;
    out->temperature_c = p->displayed.temperature_c;
    out->humidity_rh = p->displayed.humidity_rh;
  }
  const int delta = (int)m->battery_percent - (int)p->displayed.battery_percent;
  const bool battery_changed =
      m->battery_valid != p->displayed.battery_valid ||
      (m->battery_valid && (delta >= CODEPULSE_BATTERY_DELTA_PERCENT ||
                            delta <= -CODEPULSE_BATTERY_DELTA_PERCENT));
  if (!secondary_due || !battery_changed) {
    out->battery_valid = p->displayed.battery_valid;
    out->battery_percent = p->displayed.battery_percent;
  }
}
