#include "display.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_st7701.h"
#include "esp_ldo_regulator.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hal/mipi_dsi_host_ll.h"
#include "lvgl.h"

// The bundled LVGL Source Han subset omits many common Chinese characters.
// Hakimi ships a GB2312-backed font so Codex/Doubao messages do not turn into
// square placeholders when they contain ordinary Simplified Chinese text.
extern const lv_font_t hakimi_font_cjk_14;
extern const lv_image_dsc_t hakimi_pet_idle;
extern const lv_image_dsc_t hakimi_pet_working;
extern const lv_image_dsc_t hakimi_pet_waiting;
extern const lv_image_dsc_t hakimi_pet_done;

#define LCD_WIDTH 480
#define LCD_HEIGHT 640
#define UI_WIDTH 640
#define UI_HEIGHT 480
#define LCD_LANE_BITRATE_MBPS 800
#define LCD_BACKLIGHT_GPIO GPIO_NUM_26
#define LCD_RESET_GPIO GPIO_NUM_27
#define LCD_ROW_CHUNK 16

static const char *TAG = "hakimi-display-lvgl";
static esp_lcd_panel_handle_t g_panel;
static SemaphoreHandle_t g_state_mutex;
static bool g_voice_active;
static char g_agent_state[16] = "IDLE";
static char g_agent_message[512] = "Ready for input.";
static char g_input_draft[512] = "";
static int g_input_cursor;
static volatile size_t g_last_agent_ink_pixels;
static volatile size_t g_last_draft_ink_pixels;
static volatile size_t g_last_agent_label_bytes;
static volatile size_t g_last_draft_label_bytes;
static volatile uint32_t g_flush_count;

static lv_obj_t *g_state_label;
static lv_obj_t *g_rail_state_label;
static lv_obj_t *g_pet_image;
static lv_obj_t *g_agent_message_label;
static lv_obj_t *g_draft_label;
static lv_obj_t *g_agent_bubble;
static lv_obj_t *g_draft_box;

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
    {0xB0, (uint8_t[]){0x5D}, 1, 0}, {0xB1, (uint8_t[]){0x61}, 1, 0},
    {0xB2, (uint8_t[]){0x84}, 1, 0}, {0xB3, (uint8_t[]){0x80}, 1, 0},
    {0xB5, (uint8_t[]){0x4D}, 1, 0}, {0xB7, (uint8_t[]){0x85}, 1, 0},
    {0xB8, (uint8_t[]){0x20}, 1, 0}, {0xC1, (uint8_t[]){0x78}, 1, 0},
    {0xC2, (uint8_t[]){0x78}, 1, 0}, {0xD0, (uint8_t[]){0x88}, 1, 0},
    {0xE0, (uint8_t[]){0x00, 0x00, 0x02}, 3, 0},
    {0xE1, (uint8_t[]){0x06, 0xA0, 0x08, 0xA0, 0x05, 0xA0, 0x07, 0xA0, 0x00, 0x44, 0x44}, 11, 0},
    {0xE2, (uint8_t[]){0x20, 0x20, 0x44, 0x44, 0x96, 0xA0, 0x00, 0x00, 0x96, 0xA0, 0x00, 0x00}, 12, 0},
    {0xE3, (uint8_t[]){0x00, 0x00, 0x22, 0x22}, 4, 0}, {0xE4, (uint8_t[]){0x44, 0x44}, 2, 0},
    {0xE5, (uint8_t[]){0x0D, 0x91, 0xA0, 0xA0, 0x0F, 0x93, 0xA0, 0xA0, 0x09, 0x8D, 0xA0, 0xA0, 0x0B, 0x8F, 0xA0, 0xA0}, 16, 0},
    {0xE6, (uint8_t[]){0x00, 0x00, 0x22, 0x22}, 4, 0}, {0xE7, (uint8_t[]){0x44, 0x44}, 2, 0},
    {0xE8, (uint8_t[]){0x0C, 0x90, 0xA0, 0xA0, 0x0E, 0x92, 0xA0, 0xA0, 0x08, 0x8C, 0xA0, 0xA0, 0x0A, 0x8E, 0xA0, 0xA0}, 16, 0},
    {0xE9, (uint8_t[]){0x36, 0x00}, 2, 0}, {0xEB, (uint8_t[]){0x00, 0x01, 0xE4, 0xE4, 0x44, 0x88, 0x40}, 7, 0},
    {0xED, (uint8_t[]){0xFF, 0x45, 0x67, 0xFA, 0x01, 0x2B, 0xCF, 0xFF, 0xFF, 0xFC, 0xB2, 0x10, 0xAF, 0x76, 0x54, 0xFF}, 16, 0},
    {0xEF, (uint8_t[]){0x10, 0x0D, 0x04, 0x08, 0x3F, 0x1F}, 6, 0},
    {0x11, NULL, 0, 120}, {0x29, NULL, 0, 0}, {0x35, (uint8_t[]){0x00}, 1, 0},
};

static size_t utf8_byte_offset_for_character_index(const char *text, int character_index)
{
    if (character_index <= 0) return 0;
    size_t offset = 0;
    int index = 0;
    while (text[offset] != '\0' && index < character_index) {
        const unsigned char first = (unsigned char)text[offset];
        size_t sequence_length = 1;
        if ((first & 0xE0) == 0xC0) sequence_length = 2;
        else if ((first & 0xF0) == 0xE0) sequence_length = 3;
        else if ((first & 0xF8) == 0xF0) sequence_length = 4;
        for (size_t byte = 1; byte < sequence_length; byte += 1) {
            if ((text[offset + byte] & 0xC0) != 0x80) {
                sequence_length = 1;
                break;
            }
        }
        offset += sequence_length;
        index += 1;
    }
    return offset;
}

static void lvgl_flush_cb(lv_display_t *display, const lv_area_t *area, uint8_t *px_map)
{
    (void)display;
    (void)area;
    const uint16_t *source = (const uint16_t *)px_map;
    static uint16_t row[LCD_WIDTH];
    size_t agent_ink_pixels = 0;
    size_t draft_ink_pixels = 0;
    const uint16_t agent_background = (uint16_t)(((0xE1 >> 3) << 11) | ((0xE3 >> 2) << 5) | (0xDE >> 3));
    const uint16_t draft_background = (uint16_t)(((0xFB >> 3) << 11) | ((0xFA >> 2) << 5) | (0xF6 >> 3));
    for (int panel_y = 0; panel_y < LCD_HEIGHT; panel_y += LCD_ROW_CHUNK) {
        const int height = panel_y + LCD_ROW_CHUNK > LCD_HEIGHT ? LCD_HEIGHT - panel_y : LCD_ROW_CHUNK;
        for (int row_offset = 0; row_offset < height; row_offset += 1) {
            const int physical_y = panel_y + row_offset;
            for (int physical_x = 0; physical_x < LCD_WIDTH; physical_x += 1) {
                const int logical_x = physical_y;
                const int logical_y = UI_HEIGHT - 1 - physical_x;
                const uint16_t pixel = source[logical_y * UI_WIDTH + logical_x];
                row[physical_x] = pixel;
                // Count non-background pixels in the two text interiors. This
                // provides a software rendering proof because this MIPI panel
                // has no readback path for screenshots.
                if (logical_x >= 164 && logical_x < 614 && logical_y >= 66 && logical_y < 341 && pixel != agent_background) {
                    agent_ink_pixels += 1;
                }
                if (logical_x >= 22 && logical_x < 610 && logical_y >= 381 && logical_y < 423 && pixel != draft_background) {
                    draft_ink_pixels += 1;
                }
            }
            ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(g_panel, 0, physical_y, LCD_WIDTH, physical_y + 1, row));
        }
    }
    g_last_agent_ink_pixels = agent_ink_pixels;
    g_last_draft_ink_pixels = draft_ink_pixels;
    g_flush_count += 1;
    lv_display_flush_ready(display);
}

static void style_panel(lv_obj_t *object, lv_color_t color, lv_color_t border, int radius)
{
    lv_obj_set_style_bg_color(object, color, 0);
    lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(object, border, 0);
    lv_obj_set_style_border_width(object, 1, 0);
    lv_obj_set_style_radius(object, radius, 0);
}

static lv_obj_t *make_label(lv_obj_t *parent, const char *text, lv_color_t color, int size, int width, int height)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, text);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, width);
    lv_obj_set_height(label, height);
    lv_obj_set_style_text_color(label, color, 0);
    lv_obj_set_style_text_font(label, &hakimi_font_cjk_14, 0);
    // Keep the complete 14 px CJK font (which is proven on this board), but
    // scale only the high-priority text so the firmware does not need another
    // multi-megabyte full CJK font.  LVGL's transform scale uses 256 = 100%.
    // The width/height arguments for a large label are its pre-scale box;
    // callers size that box so the transformed result remains inside its card.
    lv_obj_set_style_transform_scale(label, size >= 18 ? 320 : 256, 0);
    lv_obj_set_style_transform_pivot_x(label, 0, 0);
    lv_obj_set_style_transform_pivot_y(label, 0, 0);
    return label;
}

static const lv_image_dsc_t *pet_for_state(const char *state)
{
    if (strcmp(state, "WORKING") == 0) return &hakimi_pet_working;
    if (strcmp(state, "WAITING") == 0 || strcmp(state, "ERROR") == 0) return &hakimi_pet_waiting;
    if (strcmp(state, "DONE") == 0) return &hakimi_pet_done;
    return &hakimi_pet_idle;
}

static void create_ui(void)
{
    const lv_color_t paper = lv_color_hex(0xF5F3EE);
    const lv_color_t rail = lv_color_hex(0xE8E8E2);
    const lv_color_t graphite = lv_color_hex(0x303638);
    const lv_color_t muted = lv_color_hex(0x7E8785);
    const lv_color_t line = lv_color_hex(0xC8CBC5);
    const lv_color_t cyan = lv_color_hex(0x12B8D6);
    const lv_color_t steel = lv_color_hex(0xE1E3DE);
    lv_obj_t *root = lv_screen_active();
    lv_obj_remove_style_all(root);
    lv_obj_set_style_bg_color(root, paper, 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);

    lv_obj_t *header = lv_obj_create(root);
    lv_obj_set_pos(header, 0, 0); lv_obj_set_size(header, UI_WIDTH, 42); style_panel(header, paper, line, 0);
    make_label(header, "HAKIMI  /  CODEX", graphite, 14, 220, 30);
    g_state_label = make_label(header, "IDLE", cyan, 14, 110, 30);
    lv_obj_align(g_state_label, LV_ALIGN_TOP_RIGHT, -20, 8);

    lv_obj_t *rail_panel = lv_obj_create(root);
    lv_obj_set_pos(rail_panel, 0, 42); lv_obj_set_size(rail_panel, 138, 326); style_panel(rail_panel, rail, line, 0);
    g_pet_image = lv_image_create(rail_panel);
    lv_image_set_src(g_pet_image, &hakimi_pet_idle);
    lv_obj_set_pos(g_pet_image, 21, 8);
    lv_obj_t *rail_status_title = make_label(rail_panel, "STATUS", muted, 14, 110, 22);
    lv_obj_set_pos(rail_status_title, 12, 116);
    g_rail_state_label = make_label(rail_panel, "IDLE", graphite, 18, 92, 24);
    lv_obj_set_pos(g_rail_state_label, 12, 142);
    lv_obj_t *rail_signal = make_label(rail_panel, "-- SIGNAL --", muted, 14, 110, 22);
    lv_obj_set_pos(rail_signal, 12, 194);

    lv_obj_t *chat = lv_obj_create(root);
    lv_obj_set_pos(chat, 138, 42); lv_obj_set_size(chat, UI_WIDTH - 138, 326); style_panel(chat, paper, line, 0);
    g_agent_bubble = lv_obj_create(chat);
    lv_obj_set_pos(g_agent_bubble, 14, 12); lv_obj_set_size(g_agent_bubble, 474, 302); style_panel(g_agent_bubble, steel, line, 8);
    // The output is the main thing the user reads.  There is deliberately no
    // extra "AGENT / OUTPUT" caption or second input bubble competing for space.
    // At 125% scale these become 450 x 275 px, fitting within the 474 x 302
    // output card.  Giving LVGL a 450 x 276 pre-scale box made the transformed
    // object larger than its parent and it could be clipped as a whole.
    g_agent_message_label = make_label(g_agent_bubble, g_agent_message, graphite, 18, 360, 220);
    lv_obj_set_pos(g_agent_message_label, 12, 12);

    g_draft_box = lv_obj_create(root);
    lv_obj_set_pos(g_draft_box, 10, 372); lv_obj_set_size(g_draft_box, UI_WIDTH - 20, 60); style_panel(g_draft_box, lv_color_hex(0xFBFAF6), cyan, 8);
    // Keep the single-line draft at the proven native CJK size. The output
    // card benefits from scaling, but a transformed one-line label can be
    // clipped by LVGL before it reaches the full-screen flush buffer.
    g_draft_label = make_label(g_draft_box, "|", graphite, 14, 592, 42);
    lv_obj_set_pos(g_draft_label, 12, 9);

    lv_obj_t *footer = lv_obj_create(root);
    lv_obj_set_pos(footer, 0, 434); lv_obj_set_size(footer, UI_WIDTH, 46); style_panel(footer, paper, line, 0);
    make_label(footer, "SW1  VOICE / HOLD", graphite, 14, 190, 28);
    make_label(footer, "SW2  BACKSPACE", graphite, 14, 190, 28);
    make_label(footer, "SW3  ENTER / SEND", graphite, 14, 190, 28);
    lv_obj_t *footer_second = lv_obj_get_child(footer, 1);
    lv_obj_set_pos(footer_second, 220, 8);
    lv_obj_t *footer_third = lv_obj_get_child(footer, 2);
    lv_obj_set_pos(footer_third, 440, 8);
}

static void copy_state(char *state, size_t state_size, char *message, size_t message_size, char *draft, size_t draft_size, int *cursor, bool *voice)
{
    xSemaphoreTake(g_state_mutex, portMAX_DELAY);
    snprintf(state, state_size, "%s", g_agent_state);
    snprintf(message, message_size, "%s", g_agent_message);
    snprintf(draft, draft_size, "%s", g_input_draft);
    *cursor = g_input_cursor;
    *voice = g_voice_active;
    xSemaphoreGive(g_state_mutex);
}

static void update_ui(void)
{
    char state[sizeof(g_agent_state)];
    char message[sizeof(g_agent_message)];
    char draft[sizeof(g_input_draft)];
    int cursor = 0;
    bool voice = false;
    copy_state(state, sizeof(state), message, sizeof(message), draft, sizeof(draft), &cursor, &voice);
    lv_label_set_text(g_state_label, voice ? "LISTENING" : state);
    lv_label_set_text(g_rail_state_label, voice ? "LISTEN" : state);
    const char *visible_message = message[0] ? message : "Ready for input.";
    lv_label_set_text(g_agent_message_label, visible_message);
    g_last_agent_label_bytes = strlen(visible_message);
    const lv_image_dsc_t *pet = pet_for_state(state);
    static const lv_image_dsc_t *last_pet;
    if (pet != last_pet) {
        lv_image_set_src(g_pet_image, pet);
        last_pet = pet;
    }
    const uint32_t frame_period = strcmp(state, "WORKING") == 0 ? 160 : 320;
    const uint32_t bob_frame = (lv_tick_get() / frame_period) % 4;
    const int bob_offset = bob_frame == 1 ? 1 : bob_frame == 3 ? -1 : 0;
    lv_obj_set_y(g_pet_image, 8 + bob_offset);
    char visible_draft[sizeof(g_input_draft) + 2];
    size_t length = strlen(draft);
    size_t safe_cursor = cursor < 0 ? 0 : (size_t)cursor;
    if (safe_cursor > length) safe_cursor = length;
    if (length + 1 >= sizeof(visible_draft)) length = sizeof(visible_draft) - 2;
    memcpy(visible_draft, draft, safe_cursor);
    visible_draft[safe_cursor] = '|';
    memcpy(visible_draft + safe_cursor + 1, draft + safe_cursor, length - safe_cursor);
    visible_draft[length + 1] = '\0';
    lv_label_set_text(g_draft_label, visible_draft[0] == '|' && length == 0 ? "|" : visible_draft);
    g_last_draft_label_bytes = strlen(visible_draft);
    lv_obj_set_style_border_color(g_draft_box, voice ? lv_color_hex(0xE8A126) : lv_color_hex(0x12B8D6), 0);
}

static void display_task(void *arg)
{
    (void)arg;
    while (true) {
        // The ESP-IDF port does not provide an automatic LVGL tick for this
        // minimal hardware loop. Without advancing it, the initial frame can
        // render while later label invalidations remain visually stale.
        lv_tick_inc(33);
        lv_timer_handler();
        update_ui();
        vTaskDelay(pdMS_TO_TICKS(33));
    }
}

esp_err_t hakimi_display_init(void)
{
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
    esp_lcd_dsi_bus_config_t bus_config = {.bus_id = 0, .num_data_lanes = 1, .phy_clk_src = 0, .lane_bit_rate_mbps = LCD_LANE_BITRATE_MBPS};
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus_config, &dsi_bus), TAG, "create DSI bus");
    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_dbi_io_config_t dbi_config = {.virtual_channel = 0, .lcd_cmd_bits = 8, .lcd_param_bits = 8};
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(dsi_bus, &dbi_config, &io), TAG, "create DSI DBI IO");
    mipi_dsi_host_ll_enable_cmd_ack(MIPI_DSI_LL_GET_HOST(0), false);
    esp_lcd_dpi_panel_config_t dpi_config = {
        .dpi_clk_src = MIPI_DSI_DPI_CLK_SRC_DEFAULT, .dpi_clock_freq_mhz = 24, .virtual_channel = 0,
        .pixel_format = LCD_COLOR_PIXEL_FORMAT_RGB565, .num_fbs = 1,
        .video_timing = {.h_size = LCD_WIDTH, .v_size = LCD_HEIGHT, .hsync_back_porch = 20, .hsync_pulse_width = 4,
                         .hsync_front_porch = 10, .vsync_back_porch = 14, .vsync_pulse_width = 4, .vsync_front_porch = 8},
        .flags.use_dma2d = true,
    };
    st7701_vendor_config_t vendor_config = {
        .init_cmds = g_panel_init, .init_cmds_size = sizeof(g_panel_init) / sizeof(g_panel_init[0]),
        .flags = {.use_mipi_interface = 1, .skip_mipi_id_read = 1}, .mipi_config = {.dsi_bus = dsi_bus, .dpi_config = &dpi_config},
    };
    esp_lcd_panel_dev_config_t panel_config = {.bits_per_pixel = 16, .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
                                                .reset_gpio_num = LCD_RESET_GPIO, .vendor_config = &vendor_config};
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7701(io, &panel_config, &g_panel), TAG, "create ST7701 panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(g_panel), TAG, "reset ST7701 panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(g_panel), TAG, "initialize ST7701 panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(g_panel, true), TAG, "turn on ST7701 panel");
    ESP_RETURN_ON_ERROR(gpio_set_level(LCD_BACKLIGHT_GPIO, 1), TAG, "show LCD backlight");

    lv_init();
    lv_display_t *display = lv_display_create(UI_WIDTH, UI_HEIGHT);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    const size_t buffer_bytes = UI_WIDTH * UI_HEIGHT * sizeof(uint16_t);
    void *buffer_one = heap_caps_malloc(buffer_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    void *buffer_two = heap_caps_malloc(buffer_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buffer_one || !buffer_two) return ESP_ERR_NO_MEM;
    lv_display_set_buffers(display, buffer_one, buffer_two, buffer_bytes, LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(display, lvgl_flush_cb);
    create_ui();
    update_ui();
    if (xTaskCreate(display_task, "hakimi_display", 8192, NULL, 4, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    return ESP_OK;
}

void hakimi_display_set_voice_active(bool active)
{
    if (!g_state_mutex) return;
    xSemaphoreTake(g_state_mutex, portMAX_DELAY); g_voice_active = active; xSemaphoreGive(g_state_mutex);
}

void hakimi_display_set_agent_state(const char *state)
{
    if (!g_state_mutex || !state) return;
    xSemaphoreTake(g_state_mutex, portMAX_DELAY); snprintf(g_agent_state, sizeof(g_agent_state), "%s", state); xSemaphoreGive(g_state_mutex);
}

void hakimi_display_set_agent_message(const char *message)
{
    if (!g_state_mutex || !message) return;
    xSemaphoreTake(g_state_mutex, portMAX_DELAY); snprintf(g_agent_message, sizeof(g_agent_message), "%s", message); xSemaphoreGive(g_state_mutex);
}

void hakimi_display_set_input_draft(const char *text, int cursor)
{
    if (!g_state_mutex || !text) return;
    xSemaphoreTake(g_state_mutex, portMAX_DELAY);
    snprintf(g_input_draft, sizeof(g_input_draft), "%s", text);
    // The bridge reports a character index; the display buffer is UTF-8, so
    // convert it once and keep the cursor on a code-point boundary.
    g_input_cursor = (int)utf8_byte_offset_for_character_index(g_input_draft, cursor);
    xSemaphoreGive(g_state_mutex);
}

void hakimi_display_get_debug(size_t *agent_message_bytes, size_t *input_draft_bytes, int *input_cursor,
                              size_t *agent_label_bytes, size_t *draft_label_bytes,
                              size_t *agent_ink_pixels, size_t *draft_ink_pixels, uint32_t *flush_count)
{
    if (!g_state_mutex) {
        if (agent_message_bytes) *agent_message_bytes = 0;
        if (input_draft_bytes) *input_draft_bytes = 0;
        if (input_cursor) *input_cursor = 0;
        if (agent_label_bytes) *agent_label_bytes = 0;
        if (draft_label_bytes) *draft_label_bytes = 0;
        if (agent_ink_pixels) *agent_ink_pixels = 0;
        if (draft_ink_pixels) *draft_ink_pixels = 0;
        if (flush_count) *flush_count = 0;
        return;
    }
    xSemaphoreTake(g_state_mutex, portMAX_DELAY);
    if (agent_message_bytes) *agent_message_bytes = strlen(g_agent_message);
    if (input_draft_bytes) *input_draft_bytes = strlen(g_input_draft);
    if (input_cursor) *input_cursor = g_input_cursor;
    if (agent_label_bytes) *agent_label_bytes = g_last_agent_label_bytes;
    if (draft_label_bytes) *draft_label_bytes = g_last_draft_label_bytes;
    if (agent_ink_pixels) *agent_ink_pixels = g_last_agent_ink_pixels;
    if (draft_ink_pixels) *draft_ink_pixels = g_last_draft_ink_pixels;
    if (flush_count) *flush_count = g_flush_count;
    xSemaphoreGive(g_state_mutex);
}
