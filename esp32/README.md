# ESP32 PIN gadget

A tiny desk gadget that shows the **current rotating PIN** (TOTP), so guests can read it
off the device and type it into the site. Same secret as the Lambda.

It works exactly like a hardware Google Authenticator token:
1. Sync time over WiFi (NTP) — TOTP is time-based, so the clock must be right.
2. Every second, compute the 6-digit TOTP from the shared base32 secret.
3. Show it on a small OLED (SSD1306) with a countdown bar to the next rotation.

## Hardware

- Any ESP32 dev board
- 0.96" or 1.3" I²C SSD1306 OLED (SDA→GPIO21, SCL→GPIO22 by default)

## Build (PlatformIO)

1. Copy `secrets.h.example` → `secrets.h` and fill in WiFi creds + the base32 TOTP secret
   (the same one `docs/make_parameter.py` generated). `secrets.h` is gitignored.
2. `pio run -t upload && pio device monitor`

## Libraries

Pulled in via `platformio.ini`:
- `TOTP-Arduino` (Luca Dentella) — TOTP computation
- `Adafruit SSD1306` + `Adafruit GFX` — the display
