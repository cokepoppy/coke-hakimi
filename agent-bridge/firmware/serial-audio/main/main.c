#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "driver/uart.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "es8311_codec.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "model_path.h"

#include "display.h"

#define SERIAL_BAUD_RATE 4000000
#define SAMPLE_RATE 16000
#define CHANNELS 1
#define BITS_PER_SAMPLE 16
#define FRAME_SAMPLES 320
#define FRAME_BYTES (FRAME_SAMPLES * CHANNELS * (BITS_PER_SAMPLE / 8))
#define BASE64_BYTES (((FRAME_BYTES + 2) / 3) * 4)

// The bundled official 小龙小龙 model defaults to roughly 0.624-0.628.
// Lower this modestly for the assembled single-mic enclosure; going much
// lower would make unrelated speech more likely to trigger the wake gate.
#define WAKE_DETECTION_THRESHOLD 0.56f

#define I2C_PORT I2C_NUM_0
#define I2C_SDA GPIO_NUM_7
#define I2C_SCL GPIO_NUM_8
#define I2S_PORT I2S_NUM_0
#define I2S_MCLK GPIO_NUM_13
#define I2S_BCLK GPIO_NUM_12
#define I2S_WS GPIO_NUM_10
#define I2S_DOUT GPIO_NUM_9
#define I2S_DIN GPIO_NUM_11

#define SW1_GPIO GPIO_NUM_50
#define SW2_GPIO GPIO_NUM_49
#define SW3_GPIO GPIO_NUM_5
#define BUTTON_SAMPLE_MS 5
#define BUTTON_DEBOUNCE_MS 25
#define BUTTON_LONG_PRESS_MS 700
#define CONTROL_LINE_BYTES 8192
#define CONTROL_RX_BUFFER_BYTES 8192

static const char *TAG = "hakimi-serial-audio";
static SemaphoreHandle_t uart_output_mutex;
static volatile bool g_wake_word_ready;
static const char *g_wake_word_model;

static void emit_line(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    if (uart_output_mutex) xSemaphoreTake(uart_output_mutex, portMAX_DELAY);
    vprintf(format, args);
    if (uart_output_mutex) xSemaphoreGive(uart_output_mutex);
    va_end(args);
}

static void emit_status_with_wake(const char *state, const char *detail, bool wake_word, const char *wake_word_model)
{
    emit_line(
        "{\"topic\":\"audio/status\",\"payload\":{\"state\":\"%s\",\"sampleRate\":%d,\"channels\":%d,\"bitsPerSample\":%d,\"encoding\":\"s16le\",\"wakeWord\":%s,\"wakeWordModel\":\"%s\",\"detail\":\"%s\"}}\n",
        state,
        SAMPLE_RATE,
        CHANNELS,
        BITS_PER_SAMPLE,
        wake_word ? "true" : "false",
        wake_word_model ? wake_word_model : "",
        detail
    );
}

static void emit_status(const char *state, const char *detail)
{
    emit_status_with_wake(state, detail, false, NULL);
}

typedef struct {
    esp_wn_iface_t *iface;
    model_iface_data_t *model_data;
    int16_t *chunk;
    size_t chunk_samples;
    size_t filled_samples;
    const char *model_name;
    bool ready;
} wake_detector_t;

static bool wake_detector_init(wake_detector_t *detector)
{
    memset(detector, 0, sizeof(*detector));
    srmodel_list_t *models = esp_srmodel_init("model");
    if (!models) {
        ESP_LOGW(TAG, "ESP-SR model partition is unavailable");
        return false;
    }
    char *model_name = esp_srmodel_filter(models, ESP_WN_PREFIX, "xiaolongxiaolong_tts");
    if (!model_name) {
        ESP_LOGW(TAG, "official WakeNet model xiaolongxiaolong_tts is unavailable");
        return false;
    }
    detector->iface = (esp_wn_iface_t *)esp_wn_handle_from_name(model_name);
    if (!detector->iface) {
        ESP_LOGW(TAG, "WakeNet interface is unavailable for %s", model_name);
        return false;
    }
    detector->model_data = detector->iface->create(model_name, DET_MODE_95);
    if (!detector->model_data) {
        ESP_LOGW(TAG, "WakeNet model creation failed for %s", model_name);
        return false;
    }
    const float default_threshold = detector->iface->get_det_threshold(detector->model_data, 1);
    const int threshold_result = detector->iface->set_det_threshold(
        detector->model_data,
        WAKE_DETECTION_THRESHOLD,
        1
    );
    const float configured_threshold = detector->iface->get_det_threshold(detector->model_data, 1);
    if (threshold_result != 1) {
        ESP_LOGW(TAG, "WakeNet threshold update failed: default=%.3f requested=%.3f", default_threshold, WAKE_DETECTION_THRESHOLD);
    } else {
        ESP_LOGI(TAG, "WakeNet threshold configured: default=%.3f configured=%.3f", default_threshold, configured_threshold);
    }
    detector->chunk_samples = (size_t)detector->iface->get_samp_chunksize(detector->model_data);
    detector->chunk = calloc(detector->chunk_samples, sizeof(int16_t));
    if (!detector->chunk || detector->chunk_samples == 0) {
        ESP_LOGW(TAG, "WakeNet audio buffer allocation failed");
        return false;
    }
    detector->model_name = model_name;
    detector->ready = true;
    ESP_LOGI(TAG, "WakeNet ready: %s, chunk=%u samples", model_name, (unsigned)detector->chunk_samples);
    return true;
}

static bool wake_detector_feed(wake_detector_t *detector, const int16_t *pcm, size_t sample_count)
{
    if (!detector->ready) return false;
    bool detected = false;
    size_t offset = 0;
    while (offset < sample_count) {
        const size_t remaining = detector->chunk_samples - detector->filled_samples;
        const size_t copy_count = sample_count - offset < remaining ? sample_count - offset : remaining;
        memcpy(detector->chunk + detector->filled_samples, pcm + offset, copy_count * sizeof(int16_t));
        detector->filled_samples += copy_count;
        offset += copy_count;
        if (detector->filled_samples < detector->chunk_samples) continue;
        const wakenet_state_t state = detector->iface->detect(detector->model_data, detector->chunk);
        detector->filled_samples = 0;
        if (state == WAKENET_DETECTED) {
            detected = true;
            emit_line(
                "{\"topic\":\"audio/wake\",\"payload\":{\"wakeWord\":\"%s\",\"tsMs\":%lld}}\n",
                detector->model_name,
                (long long)(esp_timer_get_time() / 1000)
            );
        }
    }
    return detected;
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
    emit_line(
        "{\"topic\":\"audio/pcm\",\"payload\":{\"seq\":%lu,\"sampleRate\":%d,\"channels\":%d,\"bitsPerSample\":%d,\"encoding\":\"s16le\",\"dataBase64\":\"%s\"}}\n",
        (unsigned long)sequence,
        SAMPLE_RATE,
        CHANNELS,
        BITS_PER_SAMPLE,
        encoded
    );
}

static void emit_input_event(const char *control, const char *event, const char *gesture, const char *action)
{
    emit_line(
        "{\"topic\":\"input/event\",\"payload\":{\"control\":\"%s\",\"event\":\"%s\",\"gesture\":\"%s\",\"action\":\"%s\",\"tsMs\":%lld}}\n",
        control,
        event,
        gesture,
        action,
        (long long)(esp_timer_get_time() / 1000)
    );
}

static void emit_input_levels(void)
{
    emit_line(
        "{\"topic\":\"input/levels\",\"payload\":{\"sw1\":%d,\"sw2\":%d,\"sw3\":%d,\"activeLow\":true,\"tsMs\":%lld}}\n",
        gpio_get_level(SW1_GPIO),
        gpio_get_level(SW2_GPIO),
        gpio_get_level(SW3_GPIO),
        (long long)(esp_timer_get_time() / 1000)
    );
}

static void emit_control_ack(const char *topic, const char *detail)
{
    size_t agent_message_bytes = 0;
    size_t input_draft_bytes = 0;
    int input_cursor = 0;
    size_t agent_label_bytes = 0;
    size_t draft_label_bytes = 0;
    size_t agent_ink_pixels = 0;
    size_t draft_ink_pixels = 0;
    uint32_t flush_count = 0;
    hakimi_display_get_debug(&agent_message_bytes, &input_draft_bytes, &input_cursor,
                             &agent_label_bytes, &draft_label_bytes,
                             &agent_ink_pixels, &draft_ink_pixels, &flush_count);
    emit_line(
        "{\"topic\":\"control/ack\",\"payload\":{\"ok\":true,\"for\":\"%s\",\"detail\":\"%s\",\"display\":{\"agentMessageBytes\":%lu,\"inputDraftBytes\":%lu,\"inputCursor\":%d,\"agentLabelBytes\":%lu,\"draftLabelBytes\":%lu,\"agentInkPixels\":%lu,\"draftInkPixels\":%lu,\"flushCount\":%lu},\"tsMs\":%lld}}\n",
        topic,
        detail,
        (unsigned long)agent_message_bytes,
        (unsigned long)input_draft_bytes,
        input_cursor,
        (unsigned long)agent_label_bytes,
        (unsigned long)draft_label_bytes,
        (unsigned long)agent_ink_pixels,
        (unsigned long)draft_ink_pixels,
        (unsigned long)flush_count,
        (long long)(esp_timer_get_time() / 1000)
    );
}

typedef struct {
    gpio_num_t gpio;
    const char *control;
    const char *event;
    const char *short_action;
    bool stable_pressed;
    bool long_sent;
    uint32_t transition_ms;
    uint32_t pressed_ms;
} button_state_t;

static void button_task(void *arg)
{
    (void)arg;
    button_state_t buttons[] = {
        {SW1_GPIO, "SW1", "button.sw1", "voice_ptt", false, false, 0, 0},
        {SW2_GPIO, "SW2", "button.sw2", "backspace", false, false, 0, 0},
        {SW3_GPIO, "SW3", "button.sw3", "agent_enter", false, false, 0, 0},
    };
    while (true) {
        for (size_t i = 0; i < sizeof(buttons) / sizeof(buttons[0]); i += 1) {
            button_state_t *button = &buttons[i];
            const bool raw_pressed = gpio_get_level(button->gpio) == 0;
            if (raw_pressed != button->stable_pressed) {
                button->transition_ms += BUTTON_SAMPLE_MS;
                if (button->transition_ms < BUTTON_DEBOUNCE_MS) continue;
                button->transition_ms = 0;
                button->stable_pressed = raw_pressed;
                if (raw_pressed) {
                    button->pressed_ms = 0;
                    button->long_sent = false;
                } else if (button->long_sent) {
                    if (i == 0) hakimi_display_set_voice_active(false);
                    emit_input_event(button->control, "button.sw1.hold", "hold_end", "voice_ptt");
                } else {
                    char event_name[32];
                    snprintf(event_name, sizeof(event_name), "%s.short_press", button->event);
                    emit_input_event(button->control, event_name, "short_press", button->short_action);
                }
            } else {
                button->transition_ms = 0;
            }
            if (button->stable_pressed) {
                button->pressed_ms += BUTTON_SAMPLE_MS;
                if (i == 0 && !button->long_sent && button->pressed_ms >= BUTTON_LONG_PRESS_MS) {
                    button->long_sent = true;
                    hakimi_display_set_voice_active(true);
                    emit_input_event(button->control, "button.sw1.hold", "hold_start", "voice_ptt");
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(BUTTON_SAMPLE_MS));
    }
}

static void copy_json_string(const char *line, const char *key, char *output, size_t output_size)
{
    output[0] = '\0';
    char needle[48];
    snprintf(needle, sizeof(needle), "\"%s\":\"", key);
    const char *start = strstr(line, needle);
    if (!start) return;
    start += strlen(needle);
    size_t written = 0;
    bool escaped = false;
    for (const char *cursor = start; *cursor != '\0'; cursor += 1) {
        if (escaped) {
            char value = *cursor;
            if (value == 'n') value = '\n';
            else if (value == 'r') value = '\r';
            else if (value == 't') value = '\t';
            if (written + 1 < output_size) output[written++] = value;
            escaped = false;
            continue;
        }
        if (*cursor == '\\') {
            escaped = true;
            continue;
        }
        if (*cursor == '"') break;
        if (written + 1 < output_size) output[written++] = *cursor;
    }
    output[written] = '\0';
}

static int copy_json_int(const char *line, const char *key, int fallback)
{
    char needle[48];
    snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char *start = strstr(line, needle);
    if (!start) return fallback;
    start += strlen(needle);
    return (int)strtol(start, NULL, 10);
}

static bool read_control_line(char *line, size_t line_size)
{
    static size_t length;
    uint8_t byte;
    while (true) {
        const int received = uart_read_bytes(UART_NUM_0, &byte, 1, pdMS_TO_TICKS(100));
        if (received <= 0) continue;
        if (byte == '\n' || byte == '\r') {
            if (length == 0) continue;
            line[length] = '\0';
            length = 0;
            return true;
        }
        if (length + 1 < line_size) line[length++] = (char)byte;
        else length = 0;
    }
}

static void control_task(void *arg)
{
    (void)arg;
    // Keep the JSONL receive buffer off this task's stack.  The long input
    // draft payload can be several kilobytes, while ESP-IDF's stack guard
    // catches an 8 KB automatic buffer before the task can process it.
    char *line = malloc(CONTROL_LINE_BYTES);
    if (!line) {
        ESP_LOGE(TAG, "control line buffer allocation failed");
        vTaskDelete(NULL);
        return;
    }
    while (read_control_line(line, CONTROL_LINE_BYTES)) {
        char topic[32];
        char status[32];
        copy_json_string(line, "topic", topic, sizeof(topic));
        if (strcmp(topic, "input/debug") == 0) {
            emit_input_levels();
            continue;
        }
        if (strcmp(topic, "audio/query") == 0) {
            emit_status_with_wake(
                g_wake_word_ready ? "ready" : "starting",
                g_wake_word_ready
                    ? "serial PCM microphone and WakeNet ready"
                    : "serial PCM microphone ready; WakeNet unavailable",
                g_wake_word_ready,
                g_wake_word_ready ? g_wake_word_model : NULL
            );
            continue;
        }
        if (strcmp(topic, "display/query") == 0) {
            emit_control_ack(topic, "display cache queried");
            continue;
        }
        if (strcmp(topic, "speech/text") == 0) {
            char body[512];
            copy_json_string(line, "body", body, sizeof(body));
            copy_json_string(line, "status", status, sizeof(status));
            if (strcmp(status, "working") == 0) hakimi_display_set_agent_state("WORKING");
            else if (strcmp(status, "error") == 0) hakimi_display_set_agent_state("ERROR");
            else if (strcmp(status, "done") == 0) hakimi_display_set_agent_state("DONE");
            else if (strcmp(status, "waiting_user") == 0) hakimi_display_set_agent_state("WAITING");
            else hakimi_display_set_agent_state("IDLE");
            hakimi_display_set_agent_message(body);
            emit_control_ack(topic, "agent message updated");
            continue;
        }
        if (strcmp(topic, "ui/input-draft") == 0) {
            char draft[512];
            copy_json_string(line, "text", draft, sizeof(draft));
            hakimi_display_set_input_draft(draft, copy_json_int(line, "cursor", 0));
            emit_control_ack(topic, "input draft updated");
            continue;
        }
        emit_control_ack(topic[0] ? topic : "unknown", "ignored control topic");
    }
    free(line);
    vTaskDelete(NULL);
}

static esp_err_t setup_buttons(void)
{
    const gpio_config_t config = {
        .pin_bit_mask = (1ULL << SW1_GPIO) | (1ULL << SW2_GPIO) | (1ULL << SW3_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&config), TAG, "button GPIO init failed");
    if (xTaskCreate(button_task, "hakimi_buttons", 3072, NULL, 8, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    emit_input_levels();
    return ESP_OK;
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
    // The assembled Hakimi microphone is quiet at the previous 24 dB setting
    // (the bridge observed roughly 40-80 RMS at idle). Use the ES8311's 36 dB
    // PGA setting so WakeNet and the post-wake command VAD receive a usable
    // signal without relying on Mac-side amplification.
    ESP_RETURN_ON_ERROR(esp_codec_dev_set_in_gain(*microphone, 36.0), TAG, "mic gain failed");
    return esp_codec_dev_open(*microphone, &sample);
}

void app_main(void)
{
    // The top Type-C connector remains on the CH343/UART path. The desktop
    // bridge uses this same link for JSONL control and Base64-wrapped PCM.
    setvbuf(stdout, NULL, _IONBF, 0);
    uart_output_mutex = xSemaphoreCreateMutex();
    ESP_ERROR_CHECK(uart_output_mutex ? ESP_OK : ESP_ERR_NO_MEM);
    const uart_config_t uart_config = {
        .baud_rate = SERIAL_BAUD_RATE,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_param_config(UART_NUM_0, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(
        UART_NUM_0,
        UART_PIN_NO_CHANGE,
        UART_PIN_NO_CHANGE,
        UART_PIN_NO_CHANGE,
        UART_PIN_NO_CHANGE
    ));
    const esp_err_t uart_driver_result = uart_driver_install(
        UART_NUM_0,
        CONTROL_RX_BUFFER_BYTES,
        4096,
        0,
        NULL,
        0
    );
    ESP_ERROR_CHECK(uart_driver_result == ESP_OK || uart_driver_result == ESP_ERR_INVALID_STATE
        ? ESP_OK : uart_driver_result);
    emit_status("starting", "initializing display, buttons, and ES8311 microphone");

    const esp_err_t display_result = hakimi_display_init();
    if (display_result != ESP_OK) {
        ESP_LOGW(TAG, "display initialization failed: %s; continuing audio-only", esp_err_to_name(display_result));
    }
    ESP_ERROR_CHECK(setup_buttons());
    if (xTaskCreate(control_task, "hakimi_control", 8192, NULL, 5, NULL) != pdPASS) {
        ESP_LOGW(TAG, "control task could not start; screen will keep local status");
    }

    esp_codec_dev_handle_t microphone = NULL;
    const esp_err_t setup_result = setup_microphone(&microphone);
    if (setup_result != ESP_OK) {
        emit_status("error", "ES8311 microphone initialization failed");
        ESP_LOGE(TAG, "microphone initialization failed: %s", esp_err_to_name(setup_result));
        return;
    }
    wake_detector_t wake_detector;
    const bool wake_word_ready = wake_detector_init(&wake_detector);
    g_wake_word_ready = wake_word_ready;
    g_wake_word_model = wake_word_ready ? wake_detector.model_name : NULL;
    emit_status_with_wake(
        "ready",
        wake_word_ready ? "serial PCM microphone and WakeNet ready" : "serial PCM microphone ready; WakeNet unavailable",
        wake_word_ready,
        wake_word_ready ? wake_detector.model_name : NULL
    );
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
        // The detector sees the same mono 16 kHz stream as the Mac.  Wake
        // words are intentionally not sent to Doubao; only audio after the
        // wake event is forwarded by the Electron state machine.
        wake_detector_feed(&wake_detector, (const int16_t *)pcm, FRAME_SAMPLES);
        emit_pcm(sequence++, pcm);
    }
}
