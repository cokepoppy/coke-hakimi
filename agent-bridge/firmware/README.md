# Hakimi firmware work area

The desktop bridge is intentionally separated from the existing Three.js
installation. Firmware work is likewise split into a safe proof image and the
eventual full-device integration:

1. `uac/` is a V3-only UAC enumeration proof. It must not be flashed as the
   final device firmware because it has no display or control runtime.
2. The full V3 image must merge the UAC component into the HachimoDock runtime,
   keep the ES8311 reader, and use a composite USB descriptor. The current
   HachimoDock vendor-native descriptor cannot simply be replaced if button
   control is expected on the same cable.

The hardware identity was measured from the connected board rather than
inferred from the product name:

```text
ESP32-P4 revision v3.2
MAC e8:f6:0a:e8:a6:ba
firmware family: v3
```

V1/V3 must stay separate. The release documentation says the packages cannot
be interchanged, so the bridge's future firmware updater will require a fresh
chip identity check before accepting an image.
