#include "display.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_st7701.h"
#include "esp_ldo_regulator.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hal/mipi_dsi_host_ll.h"

#define LCD_WIDTH 480
#define LCD_HEIGHT 640
#define UI_WIDTH 640
#define UI_HEIGHT 480
#define LCD_LANE_BITRATE_MBPS 800
#define LCD_BACKLIGHT_GPIO GPIO_NUM_26
#define LCD_RESET_GPIO GPIO_NUM_27
#define LCD_ROW_CHUNK 16

static const char *TAG = "hakimi-display";
static esp_lcd_panel_handle_t g_panel;
static SemaphoreHandle_t g_state_mutex;
static bool g_voice_active;
static char g_agent_state[16] = "READY";

// Vendor initialization for the WLK2802MIPI-15P / ST7701S 480x640 panel.
// The panel is physically portrait; the renderer below maps a 640x480 logical
// canvas into the panel coordinates so the user's horizontal installation is
// the natural orientation.
static const st7701_lcd_init_cmd_t g_panel_init[] = {
    {0xFF, (uint8_t[]){0x77, 0x01, 0x00, 0x00, 0x13}, 5, 0},
    {0xEF, (uint8_t[]){0x08}, 1, 0},
    {0xFF, (uint8_t[]){0x77, 0x01, 0x00, 0x00, 0x10}, 5, 0},
    {0xC0, (uint8_t[]){0x4F, 0x00}, 2, 0},
    {0xC1, (uint8_t[]){0x10, 0x0C}, 2, 0},
    {0xC2, (uint8_t[]){0x01, 0x14}, 2, 0},
    {0xCC, (uint8_t[]){0x10}, 1, 0},
    {0xB0, (uint8_t[]){0x0A, 0x18, 0x1E, 0x12, 0x16, 0x0C, 0x0E, 0x0D, 0x0C, 0x29, 0x06, 0x14, 0x13, 0x29, 0x33, 0x1C}, 16, 0},
    {0xB1, (uint8_t[]){0x0A, 0x19, 0x21, 0x0A, 0x0C, 0x00, 0x0C, 0x03, 0x03, 0x23, 0x01, 0x0E, 0x0C, 0x27, 0x2B, 0x1C}, 16, 0},
    {0xFF, (uint8_t[]){0x77, 0x01, 0x00, 0x00, 0x11}, 5, 0},
    {0xB0, (uint8_t[]){0x5D}, 1, 0},
    {0xB1, (uint8_t[]){0x61}, 1, 0},
    {0xB2, (uint8_t[]){0x84}, 1, 0},
    {0xB3, (uint8_t[]){0x80}, 1, 0},
    {0xB5, (uint8_t[]){0x4D}, 1, 0},
    {0xB7, (uint8_t[]){0x85}, 1, 0},
    {0xB8, (uint8_t[]){0x20}, 1, 0},
    {0xC1, (uint8_t[]){0x78}, 1, 0},
    {0xC2, (uint8_t[]){0x78}, 1, 0},
    {0xD0, (uint8_t[]){0x88}, 1, 0},
    {0xE0, (uint8_t[]){0x00, 0x00, 0x02}, 3, 0},
    {0xE1, (uint8_t[]){0x06, 0xA0, 0x08, 0xA0, 0x05, 0xA0, 0x07, 0xA0, 0x00, 0x44, 0x44}, 11, 0},
    {0xE2, (uint8_t[]){0x20, 0x20, 0x44, 0x44, 0x96, 0xA0, 0x00, 0x00, 0x96, 0xA0, 0x00, 0x00}, 12, 0},
    {0xE3, (uint8_t[]){0x00, 0x00, 0x22, 0x22}, 4, 0},
    {0xE4, (uint8_t[]){0x44, 0x44}, 2, 0},
    {0xE5, (uint8_t[]){0x0D, 0x91, 0xA0, 0xA0, 0x0F, 0x93, 0xA0, 0xA0, 0x09, 0x8D, 0xA0, 0xA0, 0x0B, 0x8F, 0xA0, 0xA0}, 16, 0},
    {0xE6, (uint8_t[]){0x00, 0x00, 0x22, 0x22}, 4, 0},
    {0xE7, (uint8_t[]){0x44, 0x44}, 2, 0},
    {0xE8, (uint8_t[]){0x0C, 0x90, 0xA0, 0xA0, 0x0E, 0x92, 0xA0, 0xA0, 0x08, 0x8C, 0xA0, 0xA0, 0x0A, 0x8E, 0xA0, 0xA0}, 16, 0},
    {0xE9, (uint8_t[]){0x36, 0x00}, 2, 0},
    {0xEB, (uint8_t[]){0x00, 0x01, 0xE4, 0xE4, 0x44, 0x88, 0x40}, 7, 0},
    {0xED, (uint8_t[]){0xFF, 0x45, 0x67, 0xFA, 0x01, 0x2B, 0xCF, 0xFF, 0xFF, 0xFC, 0xB2, 0x10, 0xAF, 0x76, 0x54, 0xFF}, 16, 0},
    {0xEF, (uint8_t[]){0x10, 0x0D, 0x04, 0x08, 0x3F, 0x1F}, 6, 0},
    {0x11, NULL, 0, 120},
    {0x29, NULL, 0, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
};

static uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

static const uint8_t *glyph(char c) {
    static const uint8_t font[26][5] = {
        {0x1E, 0x05, 0x05, 0x05, 0x1E}, {0x1F, 0x15, 0x15, 0x15, 0x0A},
        {0x0E, 0x11, 0x11, 0x11, 0x0A}, {0x1F, 0x11, 0x11, 0x0A, 0x04},
        {0x1F, 0x15, 0x15, 0x11, 0x11}, {0x1F, 0x05, 0x05, 0x01, 0x01},
        {0x0E, 0x11, 0x15, 0x15, 0x1D}, {0x1F, 0x04, 0x04, 0x04, 0x1F},
        {0x00, 0x11, 0x1F, 0x11, 0x00}, {0x08, 0x10, 0x10, 0x0F, 0x00},
        {0x1F, 0x04, 0x0A, 0x11, 0x00}, {0x1F, 0x10, 0x10, 0x10, 0x10},
        {0x1F, 0x02, 0x04, 0x02, 0x1F}, {0x1F, 0x02, 0x04, 0x08, 0x1F},
        {0x0E, 0x11, 0x11, 0x11, 0x0E}, {0x1F, 0x05, 0x05, 0x05, 0x02},
        {0x0E, 0x11, 0x19, 0x11, 0x1E}, {0x1F, 0x05, 0x0D, 0x15, 0x12},
        {0x12, 0x15, 0x15, 0x15, 0x09}, {0x01, 0x01, 0x1F, 0x01, 0x01},
        {0x0F, 0x10, 0x10, 0x10, 0x0F}, {0x07, 0x08, 0x10, 0x08, 0x07},
        {0x1F, 0x08, 0x04, 0x08, 0x1F}, {0x11, 0x0A, 0x04, 0x0A, 0x11},
        {0x01, 0x02, 0x1C, 0x02, 0x01}, {0x19, 0x15, 0x13, 0x11, 0x00},
    };
    if (c >= 'A' && c <= 'Z') return font[c - 'A'];
    return NULL;
}

static bool text_pixel(int x, int y, int x0, int y0, int scale, const char *text, uint16_t *color) {
    if (x < x0 || y < y0) return false;
    const int row = (y - y0) / scale;
    const int cell = (x - x0) / (6 * scale);
    const int col = ((x - x0) % (6 * scale)) / scale;
    if (row < 0 || row >= 7 || col < 0 || col >= 5 || !text || text[cell] == '\0') return false;
    const uint8_t *pattern = glyph(text[cell]);
    return pattern && (pattern[col] & (1U << row)) != 0;
}

static bool rect(int x, int y, int x0, int y0, int width, int height) {
    return x >= x0 && x < x0 + width && y >= y0 && y < y0 + height;
}

static uint16_t logical_pixel(int x, int y, bool voice, const char *state) {
    const uint16_t bg = rgb565(8, 12, 22);
    const uint16_t panel = rgb565(18, 29, 48);
    const uint16_t cyan = rgb565(93, 224, 255);
    const uint16_t mint = rgb565(108, 239, 174);
    const uint16_t orange = rgb565(255, 177, 75);
    const uint16_t white = rgb565(240, 248, 255);
    uint16_t color = bg;
    if (rect(x, y, 0, 0, UI_WIDTH, 62)) color = panel;
    if (rect(x, y, 0, 62, UI_WIDTH, 3)) color = voice ? orange : cyan;

    // A simple pixel-pet face makes the state visible even before text is read.
    const int dx = x - 320;
    const int dy = y - 245;
    if (dx * dx + dy * dy < 78 * 78) color = voice ? rgb565(56, 92, 125) : rgb565(45, 69, 103);
    if (rect(x, y, 258, 173, 38, 34) || rect(x, y, 344, 173, 38, 34)) color = voice ? orange : cyan;
    if (rect(x, y, 289, 228, 14, 16) || rect(x, y, 337, 228, 14, 16)) color = white;
    if (rect(x, y, 306, 276, 28, 8)) color = voice ? orange : mint;

    const char *headline = voice ? "VOICE" : (state && state[0] ? state : "READY");
    if (text_pixel(x, y, 28, 22, 4, "HAKIMI", &color)) return white;
    if (text_pixel(x, y, 260, 350, 5, headline, &color)) return voice ? orange : mint;
    if (text_pixel(x, y, 28, 405, 3, "MIC READY", &color)) return mint;
    if (text_pixel(x, y, 475, 405, 3, "AGENT", &color)) return cyan;
    return color;
}

static esp_err_t draw_frame(bool voice, const char *state) {
    static uint16_t rows[LCD_ROW_CHUNK * LCD_WIDTH];
    for (int y0 = 0; y0 < LCD_HEIGHT; y0 += LCD_ROW_CHUNK) {
        const int height = (y0 + LCD_ROW_CHUNK > LCD_HEIGHT) ? LCD_HEIGHT - y0 : LCD_ROW_CHUNK;
        for (int py = 0; py < height; py += 1) {
            const int panel_y = y0 + py;
            for (int panel_x = 0; panel_x < LCD_WIDTH; panel_x += 1) {
                // Rotate the logical 640x480 landscape canvas clockwise into
                // the physical 480x640 panel coordinate system.
                const int logical_x = panel_y;
                const int logical_y = UI_HEIGHT - 1 - panel_x;
                rows[py * LCD_WIDTH + panel_x] = logical_pixel(logical_x, logical_y, voice, state);
            }
        }
        ESP_RETURN_ON_ERROR(
            esp_lcd_panel_draw_bitmap(g_panel, 0, y0, LCD_WIDTH, y0 + height, rows),
            TAG,
            "draw LCD frame"
        );
    }
    return ESP_OK;
}

static void display_task(void *arg) {
    (void)arg;
    while (true) {
        bool voice;
        char state[sizeof(g_agent_state)];
        xSemaphoreTake(g_state_mutex, portMAX_DELAY);
        voice = g_voice_active;
        snprintf(state, sizeof(state), "%s", g_agent_state);
        xSemaphoreGive(g_state_mutex);
        if (draw_frame(voice, state) != ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        } else {
            vTaskDelay(pdMS_TO_TICKS(250));
        }
    }
}

esp_err_t hakimi_display_init(void) {
    if (g_panel) return ESP_OK;
    g_state_mutex = xSemaphoreCreateMutex();
    if (!g_state_mutex) return ESP_ERR_NO_MEM;

    gpio_config_t backlight = {
        .pin_bit_mask = 1ULL << LCD_BACKLIGHT_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&backlight), TAG, "configure LCD backlight");
    ESP_RETURN_ON_ERROR(gpio_set_level(LCD_BACKLIGHT_GPIO, 0), TAG, "hide LCD backlight");

    esp_ldo_channel_handle_t phy_power = NULL;
    esp_ldo_channel_config_t ldo_config = {.chan_id = 3, .voltage_mv = 2500};
    ESP_RETURN_ON_ERROR(esp_ldo_acquire_channel(&ldo_config, &phy_power), TAG, "enable DSI PHY power");

    esp_lcd_dsi_bus_handle_t dsi_bus = NULL;
    esp_lcd_dsi_bus_config_t bus_config = {
        .bus_id = 0,
        .num_data_lanes = 1,
        .phy_clk_src = 0,
        .lane_bit_rate_mbps = LCD_LANE_BITRATE_MBPS,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus_config, &dsi_bus), TAG, "create DSI bus");

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_dbi_io_config_t dbi_config = {
        .virtual_channel = 0,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(dsi_bus, &dbi_config, &io), TAG, "create DSI DBI IO");
    mipi_dsi_host_ll_enable_cmd_ack(MIPI_DSI_LL_GET_HOST(0), false);

    esp_lcd_dpi_panel_config_t dpi_config = {
        .dpi_clk_src = MIPI_DSI_DPI_CLK_SRC_DEFAULT,
        .dpi_clock_freq_mhz = 24,
        .virtual_channel = 0,
        .pixel_format = LCD_COLOR_PIXEL_FORMAT_RGB565,
        .num_fbs = 1,
        .video_timing = {
            .h_size = LCD_WIDTH,
            .v_size = LCD_HEIGHT,
            .hsync_back_porch = 20,
            .hsync_pulse_width = 4,
            .hsync_front_porch = 10,
            .vsync_back_porch = 14,
            .vsync_pulse_width = 4,
            .vsync_front_porch = 8,
        },
        .flags.use_dma2d = true,
    };
    st7701_vendor_config_t vendor_config = {
        .init_cmds = g_panel_init,
        .init_cmds_size = sizeof(g_panel_init) / sizeof(g_panel_init[0]),
        .flags = {.use_mipi_interface = 1, .skip_mipi_id_read = 1},
        .mipi_config = {.dsi_bus = dsi_bus, .dpi_config = &dpi_config},
    };
    esp_lcd_panel_dev_config_t panel_config = {
        .bits_per_pixel = 16,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .reset_gpio_num = LCD_RESET_GPIO,
        .vendor_config = &vendor_config,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7701(io, &panel_config, &g_panel), TAG, "create ST7701 panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(g_panel), TAG, "reset ST7701 panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(g_panel), TAG, "initialize ST7701 panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(g_panel, true), TAG, "turn on ST7701 panel");
    ESP_RETURN_ON_ERROR(gpio_set_level(LCD_BACKLIGHT_GPIO, 1), TAG, "show LCD backlight");
    ESP_RETURN_ON_ERROR(draw_frame(false, "READY"), TAG, "draw initial LCD frame");
    xTaskCreate(display_task, "hakimi_display", 4096, NULL, 4, NULL);
    return ESP_OK;
}

void hakimi_display_set_voice_active(bool active) {
    if (!g_state_mutex) return;
    xSemaphoreTake(g_state_mutex, portMAX_DELAY);
    g_voice_active = active;
    xSemaphoreGive(g_state_mutex);
}

void hakimi_display_set_agent_state(const char *state) {
    if (!g_state_mutex || !state) return;
    xSemaphoreTake(g_state_mutex, portMAX_DELAY);
    snprintf(g_agent_state, sizeof(g_agent_state), "%s", state);
    xSemaphoreGive(g_state_mutex);
}
