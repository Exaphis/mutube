# μTube

MuTube enhances YouTube on Apple TV with [TizenTube Cobalt](https://github.com/reisxd/TizenTubeCobalt)'s userscript,
which removes ads and adds support for features like SponsorBlock.

## Setup

MuTube has been tested using Frida 17.3.0 and YouTube 4.51.08 on an Apple TV 4K.

1. Install [insert_dylib](https://github.com/Tyilo/insert_dylib).

    ```bash
    git clone https://github.com/Tyilo/insert_dylib
    cd insert_dylib
    xcodebuild
    cp build/Release/insert_dylib /usr/local/bin/insert_dylib
    ```

2. Run `make`. Make sure `Makefile` points to the correct IPA file.
   Different versions of YouTube will require different addresses to instrument.
   Both the Makefile and the `main.js` file need to be updated accordingly.

## Usage

Sideload the generated `mutube.ipa` onto your Apple TV using a tool like [Sideloadly](https://sideloadly.io/).
Once installed, open the YouTube app and you should see a popup on the top right corner indicating that
TizenTube has loaded successfully.
