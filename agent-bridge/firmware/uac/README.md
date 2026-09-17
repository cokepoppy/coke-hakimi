# Hakimi Microphone / ESP32-P4 V3 proof firmware

This is a deliberately small USB Audio Class proof image for the confirmed
board revision in this workspace: **ESP32-P4 revision v3.2**. It is not the
full HachimoDock image and it is not a replacement for the display/input
runtime.

The image uses Espressif's `usb_device_uac` component and enumerates as:

```text
Hakimi Microphone · 16 kHz · 16-bit · mono
```

The default proof callback returns silence so enumeration can be tested before
the ES8311 wiring is integrated. In the full runtime, call the same initializer
with a reader that forwards to the already-initialized `esp_codec_dev_handle_t`:

```c
static esp_err_t read_es8311(uint8_t *buffer, size_t length, void *ctx) {
  return esp_codec_dev_read((esp_codec_dev_handle_t) ctx, buffer, (int) length);
}

ESP_ERROR_CHECK(hakimi_uac_init(read_es8311, microphone_handle));
```

## Build boundary

This proof project is V3-only. Build it with the installed PlatformIO ESP-IDF
5.5.4 / P4 toolchain:

```bash
cd agent-bridge/firmware/uac
~/.platformio/penv/bin/platformio run -e hakimi_uac_v3
```

The generated files are under `.pio/build/hakimi_uac_v3/`; the combined image
is `firmware.factory.bin`. The build also writes and verifies the ESP32-P4
revision bounds into the bootloader and application image headers, so this
proof cannot silently become a cross-version image. It is intentionally not
flashed automatically.

With the installed P4 V3 toolchain, this local proof is bounded to
`v3.01–v3.99`; the connected board is `v3.2`, so it is inside the verified
range. The official HachimoDock V3 release package remains the source of truth
for the eventual full device image.

Do not flash this proof image onto the device while the display assembly is in
use: it contains no screen, buttons, or HachimoDock control protocol. The next
firmware integration merges `hakimi_uac.c` into the full V3 runtime and uses a
composite descriptor (UAC microphone + control interface), so Electron keeps
receiving buttons while macOS receives audio as a normal input device.

The Type-C selector must be on the **ESP32-P4 native USB OTG** path for macOS
to see this microphone. The CH343 path remains the safer flashing/rescue path.
