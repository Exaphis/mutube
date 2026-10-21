# μTube

MuTube enhances YouTube on Apple TV with [TizenTube Cobalt’s](https://github.com/reisxd/TizenTubeCobalt) userscript,
which removes advertisements and adds support for features like SponsorBlock.

## Setup

MuTube has been tested with YouTube 4.54.01 on the Apple TV 4K (1st generation), the Apple TV 4K (3rd generation), and the Apple TV HD, also known as Apple TV (4th generation)

It has not been tested on the Apple TV 4K (2nd generation), Apple TV 4K (4th generation), Apple TV 3rd Gen, Apple TV 2nd Gen, or Apple TV 1st Gen. 

Users report that MuTube works on Apple TV 4K (2nd generation) devices. 

### Requirements

1. `uv` (used to run `patcher.py` and resolve script dependencies)
2. Xcode Command Line Tools (`xcrun` + `clang` with the AppleTV SDK)
3. A decrypted YouTube IPA

### Build

```bash
make
```

Output: `mutube.ipa`

Optional printf tracing in stubs:

```bash
make PRINTF_LOGS=1
```

The build removes `UISupportedDevices` from the app's `Info.plist`. The stock YouTube IPA only lists the
Apple TV 4K (1st and 2nd generations), so without this the Apple TV HD refuses to install the IPA. To keep the
original list:

```bash
make KEEP_SUPPORTED_DEVICES=1
```

## Usage

Sideload the generated `mutube.ipa` onto your Apple TV using a tool like [Sideloadly](https://sideloadly.io/) or [ATVLoadly](https://github.com/bitxeno/atvloadly).
Once installed, open the YouTube app and you should see a popup on the top right corner indicating that TizenTube has loaded successfully. This pop up can be removed in settings.

## Playback limits on slower devices

`inject.js` removes the `width`/`height` parameters from `MediaSource.isTypeSupported` so that YouTube offers 4K playback.
That also hides the size limits the app normally enforces, so YouTube can pick VP9 formats that devices without hardware VP9 decoding cannot keep up with, causing the video to fall behind the audio (it catches up when you pause).

To resolve this, `inject.js` applies the limits per device model, using the model in the user agent to determine proper playback configurations:

| Device | Limits |
| --- | --- |
| Apple TV 4K (1st generation) | VP9 above 1440p only up to 30 fps, so 4K60 is not offered (1440p60 and 4K30 are). HDR above 1080p only up to 30 fps (1080p60, 1440p30 and 4K30 HDR are still offered) |
| Apple TV HD | VP9 only up to 1080p30 or 720p, which are the limits the official app applies to software VP9 decoding. H.264 is not limited, so 1080p60 plays as H.264 |
| Other models | None |

Options at the top of `inject.js`:

- `BLOCK_4K_HDR`: also refuse HDR above 1440p on the devices shown above.
- `SHOW_BANNER`: show the detected device and active limits on screen for 15 seconds after load, for debugging purposes. 

### Known issues

- Apple TV 4K (1st generation): 4K30 HDR can hitch occasionally. Set `BLOCK_4K_HDR = true` to avoid it. Please note that this will remove 4K HDR support. 

- Apple TV 4K (2nd generation): untested, some reports of audio desync, no limits are currently applied. Fixes are pending further testing.

- Apple TV 4K (3rd generation): some reports of audio desync when watching content that’s over an hour long, no limits are currently applied. Fixes are pending further testing.
