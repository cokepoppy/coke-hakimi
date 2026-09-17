#pragma once

#include "sdkconfig.h"
#include "uac_config.h"
#include "tusb_config_uac.h"

#ifndef CFG_TUSB_MCU
#define CFG_TUSB_MCU OPT_MCU_ESP32P4
#endif

#ifndef CFG_TUSB_OS
#define CFG_TUSB_OS OPT_OS_FREERTOS
#endif

#define CFG_TUSB_OS_INC_PATH freertos/
#define CFG_TUD_ENABLED 1
#define CFG_TUSB_RHPORT1_MODE (OPT_MODE_DEVICE | OPT_MODE_HIGH_SPEED)
#define CFG_TUSB_DEBUG 0
#define CFG_TUD_ENDPOINT0_SIZE 64
#define CFG_TUSB_MEM_SECTION
#define CFG_TUSB_MEM_ALIGN __attribute__((aligned(4)))
