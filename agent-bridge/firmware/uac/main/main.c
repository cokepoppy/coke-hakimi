#include "esp_log.h"

#include "hakimi_uac.h"

static const char *TAG = "hakimi-uac-proof";

void app_main(void) {
    // First proof image: enumerate as a standard microphone with silence.
    // The full device supplies the ES8311 reader described in README.md.
    ESP_ERROR_CHECK(hakimi_uac_init(NULL, NULL));
    ESP_LOGI(TAG, "Connect the P4 native USB OTG port and select Hakimi Microphone in macOS");
}
