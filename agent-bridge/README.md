# Hakimi Agent Bridge

Independent macOS Electron + TypeScript bridge for the custom ESP32-P4 Hakimi firmware.

## Current slice

- Detects serial devices and opens the HachimoDock-style JSONL control channel at 4,000,000 baud.
- Shows raw device messages and serial diagnostics.
- Provides safe manual tests for Codex activation, Backspace, arrow keys, Fn, and Command+Tab.
- Reports whether macOS Accessibility is enabled.
- Has a vendor-neutral `AgentSnapshot` boundary with initial best-effort Codex and Claude Code adapters.
- Detects the connected P4 chip revision through `esptool` and records the V1/V3 family before any future firmware update.
- Maps `input/event` packets to voice PTT, cursor arrows, Backspace, and Enter; Command+Tab remains a separate bridge action.
- Drives the physical horizontal LCD with a light industrial LVGL status and
  chat screen; the three HachimoDock buttons are voice PTT, Backspace, and
  Enter/send. Command+Tab remains a bridge-side combination action.
- Ships an earlier V3-only native USB UAC proof under `firmware/uac/` for fallback/reference.
- Ships the active V3-only serial microphone proof under `firmware/serial-audio/`.

The accepted bring-up path keeps the top Type-C selector on `UART / CH343`.
The serial-audio image reads the Waveshare ES8311 microphone at 16 kHz and sends
20 ms PCM frames as JSONL. Electron forwards them to the macOS `BlackHole 2ch`
virtual microphone only while voice PTT or the explicit audio test is active;
Electron does not run ASR, so Doubao remains responsible for speech-to-text.

The current physical controls are:

- `SW1` long press: focus Codex and hold macOS `Fn` for Doubao voice input;
  release it to finish the utterance.
- `SW1` short press: no submit action; use the long press for voice PTT.
- `SW2` short press: Backspace.
- `SW3` short press: Enter/send the focused agent prompt.

Command+Tab remains available as a Mac bridge test and future combination-key
action; it is not assigned to a dedicated physical button.

The LCD is rendered as a 640x480 horizontal UI on the 480x640 ST7701S panel.
It shows `VOICE` while SW1 is held and mirrors the generic agent state
(`READY`, `WORKING`, `DONE`, or `ERROR`) sent by the Electron adapter layer.

## Run

```bash
npm install
npm run typecheck
npm start
```

Install the one-time virtual input driver if `BlackHole 2ch` is not listed by
the app:

```bash
brew install --cask blackhole-2ch
```

To rebuild the active V3 serial-audio proof (official `esp_codec_dev` plus the
Waveshare P4 pin map):

```bash
~/.platformio/penv/bin/platformio run \
  --project-dir firmware/serial-audio -e hakimi_serial_audio_v3
```

The app needs macOS Accessibility permission for window focus and synthetic key events. The default adapter intentionally treats log formats as unstable and keeps the adapter boundary separate from the renderer.

## Confirmed hardware family

The connected board was read with `esptool chip-id`:

```text
ESP32-P4 revision v3.2
MAC e8:f6:0a:e8:a6:ba
family v3
```

Use the HachimoDock V3 package for this board. V1 and V3 images are not
interchangeable; the bridge keeps this check separate from the Electron build.

To repeat the read without installing a global Python package:

```bash
~/.platformio/penv/bin/python -m esptool \
  --no-stub --chip esp32p4 \
  --port /dev/cu.usbmodem5CF71565391 chip-id
```
