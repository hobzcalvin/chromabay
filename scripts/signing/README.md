# Firmware signing

ChromaBay firmware images published for over-the-air (OTA) updates are signed with
**ECDSA P-256 / SHA-256**. Before booting a new image, the device checks the signature against
the public key compiled into the firmware (`FIRMWARE_PUBLIC_KEY` in
`esp32/src/firmware_version.h`). Signing and verification both use the mbedTLS **PSA Crypto**
API. An earlier Python-based signer produced signatures that PSA rejected (error -149), which
is why signing now happens in C.

Signing only covers OTA. Flashing over USB (esptool, or the app's "Flash a new board over USB")
does not check signatures, so you can always put your own build on your own hardware. The
app's "Install from a file…" option can also flash an unsigned image over the air, after a
warning.

## Files

| File | Purpose |
|---|---|
| `psa_sign_firmware.c` | Signs a firmware image: `./psa_sign_firmware firmware.bin private_key.raw firmware.sig`. Outputs a 64-byte raw `r‖s` signature. |
| `convert_key_to_raw.py` | Converts a PEM private key to the raw 32-byte scalar that `psa_sign_firmware` expects. |
| `../generate-signing-keys.sh` | Generates a new key pair into `keys/` (gitignored) and prints the public key as a C array. |
| `../sign_firmware.py` | Legacy Python signer. Kept for reference; its signatures don't verify on-device. |

## How CI uses them

`.github/workflows/esp32-release.yml` writes the `ESP32_SIGNING_PRIVATE_KEY` repository secret
to a PEM file, converts it with `convert_key_to_raw.py`, compiles `psa_sign_firmware.c` against
`libmbedtls-dev`, and signs every chip's image before publishing to `gh-pages`.

## Signing manually

```bash
sudo apt-get install libmbedtls-dev          # or: brew install mbedtls
python3 scripts/signing/convert_key_to_raw.py keys/esp32-signing-private.pem private_key.raw
gcc -Wall -std=c99 scripts/signing/psa_sign_firmware.c -lmbedcrypto -o psa_sign_firmware
./psa_sign_firmware esp32/.pio/build/esp32dev/firmware.bin private_key.raw firmware.sig
rm private_key.raw
```

## Running your own fork

Official ChromaBay devices only accept OTA images signed with the project's private key. To
publish OTA updates from a fork:

1. Run `scripts/generate-signing-keys.sh`. Keep `keys/esp32-signing-private.pem` secret. It
   is gitignored, along with `*.pem`, `*.sig` and `keys/`.
2. Paste the generated C array into `FIRMWARE_PUBLIC_KEY` in `esp32/src/firmware_version.h`.
3. Add the private key PEM as the `ESP32_SIGNING_PRIVATE_KEY` secret in your GitHub repo.
4. Flash the resulting firmware over USB once. After that, devices accept your signed OTA
   images.

## Troubleshooting

- **Signature rejected on device:** the device's compiled-in public key doesn't match the
  signing key, or the `.bin` was modified after signing. The serial log prints each
  verification step.
- **`psa/crypto.h` not found:** install the mbedTLS development package (see above).
