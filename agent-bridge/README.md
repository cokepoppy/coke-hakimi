# Hakimi Agent Bridge

Independent macOS Electron + TypeScript bridge for the custom ESP32-P4 Hakimi firmware.

## Current slice

- Detects serial devices and opens the HachimoDock-style JSONL control channel at 4,000,000 baud.
- Shows raw device messages and serial diagnostics.
- Provides safe manual tests for Codex activation, Backspace, arrow keys, Fn, and Command+Tab.
- Reports whether macOS Accessibility is enabled.
- Has a vendor-neutral `AgentSnapshot` boundary with Codex and Claude Code adapters.
- The Codex adapter reads the newest `~/.codex/sessions/**/*.jsonl`, prefers the
  completed turn's `last_agent_message` or assistant `final_answer`, and falls
  back to the latest assistant output while a turn is running. It removes code
  blocks and memory citations, then compacts long output before sending it to
  the small LCD.
- Detects the connected P4 chip revision through `esptool` and records the V1/V3 family before any future firmware update.
- Maps `input/event` packets to voice PTT, cursor arrows, Backspace, and Enter; Command+Tab remains a separate bridge action.
- Drives the physical horizontal LCD with a light industrial LVGL status and
  chat screen; the three HachimoDock buttons are voice PTT, Backspace, and
  Enter/send. Command+Tab remains a bridge-side combination action.
- Uses a GB2312-backed Source Han Sans SC 14 CJK font for compact labels and a
  native 20 px full CJK font for Agent output, so ordinary Chinese
  Codex/Doubao messages render without square placeholders. The larger Agent
  text is native glyph rendering rather than LVGL transform scaling, which
  keeps wrapped Chinese text visible on the physical MIPI panel.
- Embeds four 96 px RGB565 pet frames for IDLE, WORKING, WAITING/ERROR, and
  DONE in `firmware/serial-audio/main/hakimi_pet_frames.c`; the source sprite
  sheet is kept at `firmware/serial-audio/assets/hakimi_pet_sprite_sheet.png`.
- Uses a generated four-frame brick-laying sprite for the WORKING state from
  `firmware/serial-audio/assets/hakimi_pet_working_sprite.png`, converted to
  `firmware/serial-audio/main/hakimi_pet_working_anim.c`.
- Uses the 4 MB single-app partition in `firmware/serial-audio/partitions.csv`
  so the complete font and pet frames remain bootable.
- Ships an earlier V3-only native USB UAC proof under `firmware/uac/` for fallback/reference.
- Ships the active V3-only serial microphone proof under `firmware/serial-audio/`.
- Provides a keyboardless voice-assistant state machine with a VAD wake
  fallback, automatic Fn down/up endpointing, and deterministic `voice:smoke`
  coverage. The exact Chinese wake phrase remains a replaceable offline
  wake-word detector boundary.

The accepted bring-up path keeps the top Type-C selector on `UART / CH343`.
The serial-audio image reads the Waveshare ES8311 microphone at 16 kHz and sends
20 ms PCM frames as JSONL. Electron forwards command PCM to the macOS
`BlackHole 2ch` virtual microphone after the keyboardless voice state machine
detects a command segment, or while voice PTT/the explicit audio test is
active. The bridge keeps WakeNet/VAD on the raw PCM, then applies a bounded
8x gain only to the copy sent to BlackHole because the assembled ES8311 signal
is much quieter than a normal Mac microphone; override it with
`HAKIMI_VIRTUAL_MIC_GAIN` when calibrating. Electron does not run command ASR,
so Doubao remains responsible for speech-to-text.

The current physical controls are:

- `SW1` long press: focus Codex and hold macOS `Fn` for Doubao voice input;
  release it to finish the utterance.
- `SW1` short press: no submit action; use the long press for voice PTT.
- `SW2` short press: Backspace.
- `SW3` short press: Enter/send the focused agent prompt.

The keyboardless route is enabled by default for the bridge. In its current
safe fallback mode, the first short speech segment is treated as a wake
candidate and discarded; after the screen says `请说话`, the next speech
segment is sent to Doubao and stable silence releases Fn. With the official
WakeNet route, the bridge focuses the target window and presses Fn immediately
after the hardware wake event, before the command segment starts; the wake
phrase and the pause after it are still excluded from the PCM forwarded to
Doubao. Set
`HAKIMI_AUTO_VOICE=0` for display/composer regression tests without automatic
voice activation.

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

The composer watcher first reads the focused agent input through macOS
Accessibility. The current Codex desktop build is packaged as `ChatGPT.app`
and its Web composer is not exposed as an AX text field, so the bridge uses a
read-only Vision OCR fallback for the lower composer line. It never writes to
the composer or clipboard, and an unavailable snapshot does not erase the last
valid draft shown on the device.

Automated checks:

```bash
npm run composer:smoke
npm run device:smoke
npm run voice:smoke
```

`device:smoke` verifies UTF-8 message bytes, cursor position, label bytes,
software-rendered ink pixels, and LCD flushes through the serial display cache.
The MIPI panel has no screenshot readback, so final pixel appearance still
needs a physical photo of the device.

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
