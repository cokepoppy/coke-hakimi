#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef esp_err_t (*hakimi_uac_pcm_reader_t)(uint8_t *buffer, size_t length, void *ctx);

/**
 * Start the ESP32-P4 as a macOS-compatible USB Audio Class microphone.
 *
 * If reader is NULL, the device returns silence. The full HachimoDock build
 * supplies a reader that calls esp_codec_dev_read() for the ES8311 microphone.
 */
esp_err_t hakimi_uac_init(hakimi_uac_pcm_reader_t reader, void *ctx);

#ifdef __cplusplus
}
#endif
