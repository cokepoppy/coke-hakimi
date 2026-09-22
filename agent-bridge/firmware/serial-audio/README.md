# Hakimi serial-audio / ESP32-P4 V3

This is the accepted fallback audio path for the confirmed ESP32-P4 revision
v3.2. It leaves the top Type-C connector on the CH343/UART route and sends
the Waveshare ES8311 microphone to the Mac as JSONL packets:

```text
ESP32 ES8311 -> 4,000,000 baud UART -> Electron -> BlackHole 2ch -> Doubao
```

Each `audio/pcm` packet contains 20 ms of 16 kHz, mono, signed 16-bit little-
endian PCM encoded as Base64. Electron only forwards packets after the official
WakeNet event (or the VAD fallback), while the command is being spoken. No ASR
API is involved: Doubao receives the PCM through BlackHole and performs the
transcription itself.

This build includes Espressif's official ESP-SR model
`wn9_xiaolongxiaolong_tts` (小龙小龙). The exact phrase 小哈小哈 is not one of
the bundled official models. At boot the board sends:

```json
{"topic":"audio/status","payload":{"wakeWord":true,"wakeWordModel":"wn9_xiaolongxiaolong_tts"}}
```

When the model detects the phrase it sends `audio/wake`. The bridge then
focuses the active agent window, presses macOS Fn, and forwards only the next
command segment. If the model partition is unavailable, the bridge reports
`wakeWord:false` and uses the existing VAD fallback.

The firmware configures the ES8311 microphone PGA at 36 dB. The bridge uses a
separate lower post-wake speech threshold for this board because its ES8311
PCM amplitude is lower than a Mac microphone; WakeNet remains the wake gate.

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

The generated factory image includes the application, partition table, and
ESP-SR model partition:

```text
.pio/build/hakimi_serial_audio_v3/firmware.factory.bin
```

The post-build hook bounds both images to ESP32-P4 full revisions 300-399 and
packs `srmodels.bin` into the 8 MB model partition at 0x810000. The application
partition is 8 MB because the official WakeNet runtime makes the firmware
larger than the previous 4 MB layout.
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
the same `voice_ptt` action without a hold gesture and is ignored by the
bridge; SW2 emits `backspace`; SW3 emits `agent_enter`.

The firmware keeps PSRAM enabled for the LCD framebuffers. The default physical
button mapping is SW1 voice push-to-talk, SW2 Backspace, and SW3 Enter/send;
Command+Tab remains a bridge-side combination action. For the CH343
upload path, use the no-stub command below if PlatformIO's 921600 baud upload
reports `Invalid head of packet`:

```bash
~/.platformio/penv/bin/python -m esptool --no-stub --chip esp32p4 \
  --port /dev/cu.usbmodem5CF71565391 --baud 460800 \
  write-flash 0x0 .pio/build/hakimi_serial_audio_v3/firmware.factory.bin
```
