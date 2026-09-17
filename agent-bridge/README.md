# Hakimi Agent Bridge

Independent macOS Electron + TypeScript bridge for the custom ESP32-P4 Hakimi firmware.

## Current slice

- Detects serial devices and opens the HachimoDock-style JSONL control channel at 4,000,000 baud.
- Shows raw device messages and serial diagnostics.
- Provides safe manual tests for Codex activation, Backspace, arrow keys, Fn, and Command+Tab.
- Reports whether macOS Accessibility is enabled.
- Has a vendor-neutral `AgentSnapshot` boundary with initial best-effort Codex and Claude Code adapters.
- Detects the connected P4 chip revision through `esptool` and records the V1/V3 family before any future firmware update.
- Maps `input/event` packets to voice PTT, cursor arrows, Backspace, Enter, and Command+Tab.
- Ships a V3-only UAC microphone proof under `firmware/uac/`; the proof is intentionally not flashed automatically.

The current ESP32 Hello World firmware is not yet a standard macOS microphone. The
UAC proof exposes a standard `Hakimi Microphone` on the P4 native USB OTG path;
the final device image still needs a composite UAC + control descriptor so audio
and buttons can share one native USB cable. The audio bytes go directly from the
ESP32 to macOS audio; Electron must not run ASR.

## Run

```bash
npm install
npm run typecheck
npm start
```

To rebuild only the V3 UAC proof:

```bash
~/.platformio/penv/bin/platformio run \
  --project-dir firmware/uac -e hakimi_uac_v3
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
