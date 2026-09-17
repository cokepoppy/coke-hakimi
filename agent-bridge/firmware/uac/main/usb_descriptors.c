#include <string.h>

#include "tusb.h"
#include "uac_descriptors.h"

// The standalone proof has one AudioControl interface and one microphone
// AudioStreaming interface. Keeping the numbers explicit is required when
// CONFIG_USB_DEVICE_UAC_AS_PART is enabled.
enum {
    ITF_NUM_AUDIO_CONTROL = 0,
    ITF_NUM_AUDIO_STREAMING_MIC = 1,
    ITF_NUM_TOTAL = 2,
};

#define EPNUM_AUDIO_IN 0x82
#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_AUDIO_DEVICE_DESC_LEN)

#define HAKIMI_UAC_VID 0x303A
#define HAKIMI_UAC_PID 0x8103
#define HAKIMI_UAC_MANUFACTURER "Coke Hakimi"
#define HAKIMI_UAC_PRODUCT "Hakimi Microphone"
#define HAKIMI_UAC_SERIAL "hakimi-p4-v3"

tusb_desc_device_t const desc_device = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200,
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = HAKIMI_UAC_VID,
    .idProduct = HAKIMI_UAC_PID,
    .bcdDevice = 0x0100,
    .iManufacturer = 0x01,
    .iProduct = 0x02,
    .iSerialNumber = 0x03,
    .bNumConfigurations = 0x01,
};

uint8_t const *tud_descriptor_device_cb(void) {
    return (uint8_t const *)&desc_device;
}

uint8_t const desc_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0x00, 100),
    TUD_AUDIO_DESCRIPTOR(ITF_NUM_AUDIO_CONTROL, 4, 0, EPNUM_AUDIO_IN, 0),
};

uint8_t const *tud_descriptor_configuration_cb(uint8_t index) {
    (void)index;
    return desc_configuration;
}

static char const *string_desc_arr[] = {
    (const char[]){0x09, 0x04},
    HAKIMI_UAC_MANUFACTURER,
    HAKIMI_UAC_PRODUCT,
    HAKIMI_UAC_SERIAL,
    "usb uac",
    "microphone",
};

static uint16_t desc_str[32];

uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void)langid;

    uint8_t count;
    if (index == 0) {
        memcpy(&desc_str[1], string_desc_arr[0], 2);
        count = 1;
    } else {
        if (index >= sizeof(string_desc_arr) / sizeof(string_desc_arr[0])) {
            return NULL;
        }
        char const *str = string_desc_arr[index];
        count = (uint8_t)strlen(str);
        if (count > 31) count = 31;
        for (uint8_t i = 0; i < count; ++i) desc_str[1 + i] = str[i];
    }

    desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * count + 2));
    return desc_str;
}
