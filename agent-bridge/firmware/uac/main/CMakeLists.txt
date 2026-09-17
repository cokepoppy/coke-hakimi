idf_component_register(
  SRCS "main.c" "hakimi_uac.c" "usb_descriptors.c"
  INCLUDE_DIRS "."
  REQUIRES espressif__usb_device_uac
)

idf_component_get_property(UAC_COMPONENT_DIR espressif__usb_device_uac COMPONENT_DIR)
target_include_directories(${COMPONENT_LIB} PRIVATE "${UAC_COMPONENT_DIR}/tusb_uac")

idf_component_get_property(TINYUSB_LIB espressif__tinyusb COMPONENT_LIB)
target_include_directories(${TINYUSB_LIB} PUBLIC
  "${CMAKE_CURRENT_LIST_DIR}"
  "${UAC_COMPONENT_DIR}/tusb"
  "${UAC_COMPONENT_DIR}/tusb_uac"
)

idf_component_get_property(UAC_LIB espressif__usb_device_uac COMPONENT_LIB)
target_include_directories(${UAC_LIB} PUBLIC
  "${CMAKE_CURRENT_LIST_DIR}"
  "${UAC_COMPONENT_DIR}/tusb"
  "${UAC_COMPONENT_DIR}/tusb_uac"
)
