#pragma once

#include <stdbool.h>

#include "esp_err.h"

esp_err_t hakimi_display_init(void);
void hakimi_display_set_voice_active(bool active);
void hakimi_display_set_agent_state(const char *state);
void hakimi_display_set_agent_message(const char *message);
void hakimi_display_set_input_draft(const char *text, int cursor);
