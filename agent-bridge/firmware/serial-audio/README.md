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
inside that gate. This proof does not yet include the full HachimoDock screen
renderer or button protocol; the first hardware test is microphone transport.
