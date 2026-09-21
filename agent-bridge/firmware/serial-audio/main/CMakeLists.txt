idf_component_register(
  # display.c is the original hand-drawn pixel fallback. The V3 build uses
  # the LVGL implementation while keeping the fallback in the tree for
  # recovery and comparison.
  SRCS "main.c" "display_lvgl.c" "hakimi_font_cjk_14.c" "hakimi_font_cjk_16.c" "hakimi_font_cjk_18.c" "hakimi_pet_frames.c"
  INCLUDE_DIRS "."
  REQUIRES lvgl espressif__esp_codec_dev espressif__esp_lcd_st7701
)
