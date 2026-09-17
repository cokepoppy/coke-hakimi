#include "hakimi_uac.h"

#include <string.h>

#include "esp_log.h"
#include "usb_device_uac.h"

static const char *TAG = "hakimi-uac";
static hakimi_uac_pcm_reader_t g_reader;
static void *g_reader_ctx;

static esp_err_t microphone_input_cb(
    uint8_t *buffer,
    size_t length,
    size_t *bytes_read,
    void *ctx
) {
    (void) ctx;
    if (!buffer || !bytes_read) return ESP_ERR_INVALID_ARG;

    // The UAC component calls this on its microphone task at the configured
    // interval. A codec read is allowed to block here until one PCM block is
    // available; this keeps audio timing in the UAC task and avoids an ASR or
    // JSON/base64 hop through the desktop application.
    if (g_reader && g_reader(buffer, length, g_reader_ctx) == ESP_OK) {
        *bytes_read = length;
        return ESP_OK;
    }

    // Silence is a safe fallback during bring-up and makes enumeration tests
    // independent from the ES8311 wiring. It is not an ASR path.
    memset(buffer, 0, length);
    *bytes_read = length;
    return ESP_OK;
}

esp_err_t hakimi_uac_init(hakimi_uac_pcm_reader_t reader, void *ctx) {
    g_reader = reader;
    g_reader_ctx = ctx;
    uac_device_config_t config = {
        .skip_tinyusb_init = false,
        .output_cb = NULL,
        .input_cb = microphone_input_cb,
        .set_mute_cb = NULL,
        .set_volume_cb = NULL,
        .cb_ctx = NULL,
        .spk_itf_num = -1,
        .mic_itf_num = 1,
    };
    esp_err_t err = uac_device_init(&config);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "UAC microphone ready: 16000 Hz, 16-bit, mono, product=Hakimi Microphone");
    }
    return err;
}
