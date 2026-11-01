#pragma once
/* Deliberate opt-in build; ordinary firmware remains on PAIR125. */
#if defined(CODEPULSE_QUIET_PAIR150_TRIAL) && CODEPULSE_QUIET_PAIR150_TRIAL
#define EPD_QUIET_PAIR_FRAMES 150
#define EPD_QUIET_PROFILE_NAME "PAIR150_TRIAL"
#define EPD_QUIET_LOG_MODE "quiet_pair150_trial"
#else
#define EPD_QUIET_PAIR_FRAMES 125
#define EPD_QUIET_PROFILE_NAME "PAIR125"
#define EPD_QUIET_LOG_MODE "quiet_pair125"
#endif
