#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "driver/uart.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_log.h"
#include "es8311_codec.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"

#define SERIAL_BAUD_RATE 4000000
#define SAMPLE_RATE 16000
#define CHANNELS 1
#define BITS_PER_SAMPLE 16
#define FRAME_SAMPLES 320
#define FRAME_BYTES (FRAME_SAMPLES * CHANNELS * (BITS_PER_SAMPLE / 8))
#define BASE64_BYTES (((FRAME_BYTES + 2) / 3) * 4)

#define I2C_PORT I2C_NUM_0
#define I2C_SDA GPIO_NUM_7
#define I2C_SCL GPIO_NUM_8
#define I2S_PORT I2S_NUM_0
#define I2S_MCLK GPIO_NUM_13
#define I2S_BCLK GPIO_NUM_12
#define I2S_WS GPIO_NUM_10
#define I2S_DOUT GPIO_NUM_9
#define I2S_DIN GPIO_NUM_11

static const char *TAG = "hakimi-serial-audio";

static void emit_status(const char *state, const char *detail)
{
    printf(
        "{\"topic\":\"audio/status\",\"payload\":{\"state\":\"%s\",\"sampleRate\":%d,\"channels\":%d,\"bitsPerSample\":%d,\"encoding\":\"s16le\",\"detail\":\"%s\"}}\n",
        state,
        SAMPLE_RATE,
        CHANNELS,
        BITS_PER_SAMPLE,
        detail
    );
}

static void emit_pcm(uint32_t sequence, const uint8_t *pcm)
{
    char encoded[BASE64_BYTES + 1];
    size_t encoded_length = 0;
    const int result = mbedtls_base64_encode(
        (unsigned char *)encoded,
        sizeof(encoded),
        &encoded_length,
        pcm,
        FRAME_BYTES
    );
    if (result != 0) {
        ESP_LOGE(TAG, "PCM base64 encode failed: %d", result);
        return;
    }
    encoded[encoded_length] = '\0';
    printf(
        "{\"topic\":\"audio/pcm\",\"payload\":{\"seq\":%lu,\"sampleRate\":%d,\"channels\":%d,\"bitsPerSample\":%d,\"encoding\":\"s16le\",\"dataBase64\":\"%s\"}}\n",
        (unsigned long)sequence,
        SAMPLE_RATE,
        CHANNELS,
        BITS_PER_SAMPLE,
        encoded
    );
}

static esp_err_t setup_microphone(esp_codec_dev_handle_t *microphone)
{
    i2c_master_bus_config_t i2c_config = {
        .i2c_port = I2C_PORT,
        .sda_io_num = I2C_SDA,
        .scl_io_num = I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c_bus = NULL;
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&i2c_config, &i2c_bus), TAG, "I2C init failed");

    i2s_chan_handle_t rx_handle = NULL;
    i2s_chan_config_t channel_config = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    channel_config.auto_clear = true;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&channel_config, NULL, &rx_handle), TAG, "I2S channel failed");
    i2s_std_config_t std_config = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_MCLK,
            .bclk = I2S_BCLK,
            .ws = I2S_WS,
            .dout = I2S_DOUT,
            .din = I2S_DIN,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false,
            },
        },
    };
    std_config.clk_cfg.mclk_multiple = 384;
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(rx_handle, &std_config), TAG, "I2S mode failed");
    ESP_RETURN_ON_ERROR(i2s_channel_enable(rx_handle), TAG, "I2S enable failed");

    audio_codec_i2s_cfg_t data_config = {
        .port = I2S_PORT,
        .rx_handle = rx_handle,
        .tx_handle = NULL,
    };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&data_config);
    if (!data_if) return ESP_ERR_NO_MEM;

    audio_codec_i2c_cfg_t control_config = {
        .port = I2C_PORT,
        .addr = ES8311_CODEC_DEFAULT_ADDR,
        .bus_handle = i2c_bus,
    };
    const audio_codec_ctrl_if_t *control_if = audio_codec_new_i2c_ctrl(&control_config);
    const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();
    if (!control_if || !gpio_if) return ESP_ERR_NO_MEM;

    es8311_codec_cfg_t codec_config = {
        .ctrl_if = control_if,
        .gpio_if = gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_ADC,
        .pa_pin = GPIO_NUM_NC,
        .pa_reverted = false,
        .master_mode = false,
        .use_mclk = true,
        .digital_mic = false,
        .invert_mclk = false,
        .invert_sclk = false,
        .hw_gain = {
            .pa_voltage = 5.0,
            .codec_dac_voltage = 3.3,
        },
        .no_dac_ref = true,
        .mclk_div = 384,
    };
    const audio_codec_if_t *codec_if = es8311_codec_new(&codec_config);
    if (!codec_if) return ESP_ERR_NO_MEM;

    esp_codec_dev_cfg_t device_config = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
        .codec_if = codec_if,
        .data_if = data_if,
    };
    *microphone = esp_codec_dev_new(&device_config);
    if (!*microphone) return ESP_ERR_NO_MEM;

    esp_codec_dev_sample_info_t sample = {
        .sample_rate = SAMPLE_RATE,
        .channel = CHANNELS,
        .channel_mask = 0x01,
        .bits_per_sample = BITS_PER_SAMPLE,
        .mclk_multiple = 384,
    };
    ESP_RETURN_ON_ERROR(esp_codec_dev_set_in_gain(*microphone, 24.0), TAG, "mic gain failed");
    return esp_codec_dev_open(*microphone, &sample);
}

void app_main(void)
{
    // The top Type-C connector remains on the CH343/UART path. The desktop
    // bridge uses this same link for JSONL control and Base64-wrapped PCM.
    setvbuf(stdout, NULL, _IONBF, 0);
    ESP_ERROR_CHECK(uart_set_baudrate(UART_NUM_0, SERIAL_BAUD_RATE));
    emit_status("starting", "initializing ES8311 microphone");

    esp_codec_dev_handle_t microphone = NULL;
    const esp_err_t setup_result = setup_microphone(&microphone);
    if (setup_result != ESP_OK) {
        emit_status("error", "ES8311 microphone initialization failed");
        ESP_LOGE(TAG, "microphone initialization failed: %s", esp_err_to_name(setup_result));
        return;
    }
    emit_status("ready", "serial PCM microphone ready");
    ESP_LOGI(TAG, "serial audio ready: %d Hz, %d-bit, mono, %d-byte frames", SAMPLE_RATE, BITS_PER_SAMPLE, FRAME_BYTES);

    uint8_t pcm[FRAME_BYTES];
    uint32_t sequence = 0;
    while (true) {
        memset(pcm, 0, sizeof(pcm));
        const int result = esp_codec_dev_read(microphone, pcm, sizeof(pcm));
        if (result != ESP_CODEC_DEV_OK) {
            emit_status("error", "esp_codec_dev_read failed");
            ESP_LOGE(TAG, "microphone read failed: %d", result);
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        emit_pcm(sequence++, pcm);
    }
}
