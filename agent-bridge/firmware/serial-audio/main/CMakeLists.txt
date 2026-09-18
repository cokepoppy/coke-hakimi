idf_component_register(
  SRCS "main.c" "display.c"
  INCLUDE_DIRS "."
  REQUIRES espressif__esp_codec_dev espressif__esp_lcd_st7701
)
