#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

esp_err_t hakimi_display_init(void);
void hakimi_display_set_voice_active(bool active);
void hakimi_display_set_agent_state(const char *state);
void hakimi_display_set_agent_message(const char *message);
void hakimi_display_set_input_draft(const char *text, int cursor);
void hakimi_display_get_debug(size_t *agent_message_bytes, size_t *input_draft_bytes, int *input_cursor,
                              size_t *agent_label_bytes, size_t *draft_label_bytes,
                              size_t *agent_ink_pixels, size_t *draft_ink_pixels, uint32_t *flush_count);
