# Third-Party Notices

ChromaBay incorporates the open-source components listed below. Each is the property of
its respective copyright holders and is used under the stated license. This file is provided
to satisfy the attribution / notice requirements of those licenses.

> ChromaBay's own first-party license has not yet been declared — see the README/`LICENSE`
> (TODO). This file covers third-party components only.

---

## App (web / iOS / Android — `package.json`)

All app dependencies are permissive (MIT / ISC / Apache-2.0).

| Component | Version | License | Copyright |
|---|---|---|---|
| @capacitor/core, /cli, /android, /ios, /app, /preferences | ^7.x | MIT | © Ionic (Drifty Co.) |
| @capacitor-community/bluetooth-le | ^7.1.1 | MIT | © Capacitor Community |
| @capawesome/capacitor-live-update | ^7.2.0 | MIT | © 2022 Robin Genz |
| capacitor-plugin-ios-webview-configurator | ^0.4.0 | MIT | © the plugin authors |
| @xyflow/svelte | ^1.0.2 | MIT | © webkid GmbH |
| pixi.js | ^8.10.1 | MIT | © Mathew Groves, Chad Engler |
| @msgpack/msgpack | ^3.1.2 | ISC | © The MessagePack community |
| svelte, @sveltejs/kit, @sveltejs/vite-plugin-svelte, @sveltejs/adapter-static, @sveltejs/adapter-auto | various | MIT | © the Svelte contributors |
| vite | ^6.x | MIT | © 2019-present VoidZero & Vite contributors |
| typescript | ^5.x | Apache-2.0 | © Microsoft Corporation |
| esp-web-tools | ^10.x | Apache-2.0 | © Nabu Casa / ESPHome |
| (dev) vitest, @vitest/ui, jsdom, playwright, svelte-check, chokidar, gh-pages, husky, @types/* | various | MIT / ISC | © respective authors |

The MIT and ISC licenses require their notice be reproduced in distributions; the canonical
texts are included below. Apache-2.0 components (TypeScript, esp-web-tools) are governed by the
Apache License 2.0 — see <https://www.apache.org/licenses/LICENSE-2.0> and propagate any upstream
`NOTICE` files.

---

## Firmware (ESP32 — `esp32/platformio.ini`)

| Component | Version | License | Copyright |
|---|---|---|---|
| FastLED | 3.7.7 | MIT | © Daniel Garcia, Mark Kriegsman & contributors |
| h2zero/NimBLE-Arduino | 1.4.3 | Apache-2.0 | © h2zero & contributors |
| makuna/NeoPixelBus | 2.8.4 | **LGPL-3.0** | © Michael C. Miller & contributors |
| arduino-esp32 core (espressif32 @ 7.0.1, framework 3.20017) | 3.20017 | **LGPL-2.1-or-later** | © Espressif Systems & contributors |
| ESP-IDF (bundled in the core) | — | Apache-2.0 (+ BSD/MIT parts) | © Espressif Systems |

### LGPL components — source availability & relinking offer

ChromaBay's firmware statically links two GNU LGPL libraries: **NeoPixelBus 2.8.4 (LGPL-3.0)**
and the **Arduino-ESP32 core 3.20017 (LGPL-2.1-or-later)**. These libraries are used **unmodified**.

To honor the LGPL, for any distributed firmware binary (e.g. OTA images or firmware on shipped
hardware) ChromaBay provides:

- **Complete corresponding source** of the LGPL libraries at the exact pinned versions:
  - NeoPixelBus 2.8.4 — <https://github.com/Makuna/NeoPixelBus/tree/2.8.4>
  - Arduino-ESP32 3.20017 — <https://github.com/espressif/arduino-esp32> (release matching framework 3.20017)
- **A relinkable form** of the application: the firmware is built with PlatformIO from the pinned
  `esp32/platformio.ini`; the compiled object/library artifacts under `esp32/.pio/build/` plus that
  manifest let a recipient substitute a modified NeoPixelBus / core build and re-link the image.
- The full **LGPL-3.0** and **LGPL-2.1** license texts:
  <https://www.gnu.org/licenses/lgpl-3.0.txt> and <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt>.
- No technical measure prevents loading a relinked image (no enforced secure boot).

---

## License texts

### MIT License
```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### ISC License
```
Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
OF THIS SOFTWARE.
```

- **Apache-2.0**: <https://www.apache.org/licenses/LICENSE-2.0>
- **LGPL-3.0**: <https://www.gnu.org/licenses/lgpl-3.0.txt>
- **LGPL-2.1**: <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt>

_Generated as part of the ChromaBay licensing review. Update when dependencies change._
