# Hakimi serial-audio / ESP32-P4 V3

This is the accepted fallback audio path for the confirmed ESP32-P4 revision
v3.2. It leaves the top Type-C connector on the CH343/UART route and sends
the Waveshare ES8311 microphone to the Mac as JSONL packets:

```text
ESP32 ES8311 -> 4,000,000 baud UART -> Electron -> BlackHole 2ch -> Doubao
```

Each `audio/pcm` packet contains 20 ms of 16 kHz, mono, signed 16-bit little-
endian PCM encoded as Base64. Electron only forwards packets while the voice
push-to-talk action is active, or while its explicit audio test button is on.
No ASR API is involved.

The project is V3-only. It uses Espressif's official `esp_codec_dev` ES8311
driver and the Waveshare P4 pin map (I2C 7/8, I2S 13/12/10/9/11). Build with
the installed PlatformIO ESP-IDF 5.5.4 / P4 toolchain:

```bash
cd agent-bridge/firmware/serial-audio
~/.platformio/penv/bin/platformio run -e hakimi_serial_audio_v3
```

The CH343 flashing speed is deliberately 460800: this board produced a
packet-noise error when esptool switched the same link to 921600. The runtime
audio JSONL link changes to 4,000,000 baud after the application starts.

The generated factory image is:

```text
.pio/build/hakimi_serial_audio_v3/firmware.factory.bin
```

The post-build hook bounds both images to ESP32-P4 full revisions 300-399.
The device currently detected in this workspace is revision 3.2, so it is
inside that gate.

This image also initializes the horizontal K2802MIPI-15P V2 / ST7701S LCD and
the three physical controls from the HachimoDock V3 mapping:

```text
LCD reset GPIO27 · backlight GPIO26 · one-lane MIPI DSI · 480x640 panel
SW1 GPIO50 · SW2 GPIO49 · SW3 GPIO5 (active low with pull-ups)
```

The rendered logical canvas is 640x480 and is rotated into the panel, so the
screen is intended to be mounted horizontally. `SW1` long press emits
`button.sw1.hold` with `voice_ptt` start/end gestures; SW1 short press emits
`agent_prompt`; SW2 emits `backspace`; SW3 emits `command_tab`.

The firmware keeps PSRAM enabled for the LCD framebuffers. For the CH343
upload path, use the no-stub command below if PlatformIO's 921600 baud upload
reports `Invalid head of packet`:

```bash
~/.platformio/penv/bin/python -m esptool --no-stub --chip esp32p4 \
  --port /dev/cu.usbmodem5CF71565391 --baud 460800 \
  write-flash 0x0 .pio/build/hakimi_serial_audio_v3/firmware.factory.bin
```
