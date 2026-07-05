# genesis_totp

A single-account hardware TOTP token (like Google Authenticator) for the
Axiometa Genesis Mini (ESP32-S3), displaying the rolling 6-digit code on the
Axiometa 0.96" IPS LCD (ST7735S, 160×80, SPI). **Confirmed working end-to-end.**

## What it does

- Stores **one** base32 TOTP secret in NVS flash (provisioned once over serial —
  never in source).
- Syncs UTC time from **NTP over Wi-Fi**.
- Generates the RFC 6238 code (SHA-1, 30s period, 6 digits — Google Authenticator
  defaults) and shows it with a 30-second countdown bar.
- RGB LED (GPIO21): red = starting, amber = syncing, green = time valid.

## Hardware wiring

Display: Axiometa IPS LCD 0.96" (AX22-0034), **ST7735S / 160×80 / 4-wire SPI**,
in **AX22 Port 1**. All AX22 ports share the SPI bus; each port's 3 GPIOs carry
CS/DC/RST. The panel is **BGR-ordered** (corrected in firmware via `C(r,g,b)`).

| Function | Pin | Notes |
|---|---|---|
| SPI MOSI | IO12 | shared AX22 SPI bus |
| SPI SCK | IO14 | shared AX22 SPI bus |
| TFT CS | IO4 | Port 1 GPIO |
| TFT DC | IO2 | Port 1 GPIO |
| TFT RST | IO3 | Port 1 GPIO |
| User button | GPIO45 | active-low |
| Status RGB LED | GPIO21 | — |

Init: `tftSPI(FSPI)`, `initR(INITR_MINI160x80)`, `setRotation(3)`.

### Moving the display to another port

Set `#define PIN_HUNT 1` in the sketch, flash, and watch the screen cycle 6
numbered color screens; whichever renders cleanly tells you the CS/DC/RST
arrangement. Update `TFT_CS/DC/RST`, set `PIN_HUNT 0`, reflash.

## Boards (multi-board via `board_config.h`)

The same firmware targets two boards. Select the target in
[board_config.h](board_config.h) (`#define TARGET_BOARD ...`) or override with a
build flag. All board-specific wiring/driver/layout lives in that header.

| | Genesis Mini | CYD ESP32-2432S028R |
|---|---|---|
| MCU | ESP32-S3 | ESP32-WROOM |
| Display | ST7735S 160×80 (SPI, BGR) | ILI9341 240×320 (SPI) |
| TFT pins | FSPI; CS=4 DC=2 RST=3 (Port 1) | HSPI SCLK=14 MOSI=13 MISO=12 CS=15 DC=2; **BL=21 (HIGH)** |
| RGB LED | NeoPixel GPIO21 | 3-pin common-anode R=4/G=16/B=17 (active-low) |
| Button | USER GPIO45 | BOOT GPIO0 |
| FQBN | `esp32:esp32:axiometa_genesis_mini` | `esp32:esp32:esp32` |
| Serial port | `/dev/cu.usbmodem*` | `/dev/cu.usbserial*` (CP2102/CH340) |

CYD extras present but unused: resistive touch (XPT2046: CLK25/CS33/MOSI32/MISO39/IRQ36),
microSD (CS5), LDR light sensor (GPIO34).

## Build & flash

**Genesis Mini** (default target):
```bash
arduino-cli compile --fqbn esp32:esp32:axiometa_genesis_mini firmware/genesis_totp
arduino-cli upload  --fqbn esp32:esp32:axiometa_genesis_mini \
  -p /dev/cu.usbmodem2101 firmware/genesis_totp
```

**CYD ESP32-2432S028R** — set `#define TARGET_BOARD BOARD_CYD` in `board_config.h`
(or pass the flag shown), then:
```bash
FLAG='compiler.cpp.extra_flags=-DTARGET_BOARD=2'   # only if not editing the header
arduino-cli compile --fqbn esp32:esp32:esp32 --build-property "$FLAG" firmware/genesis_totp
arduino-cli upload  --fqbn esp32:esp32:esp32 --build-property "$FLAG" \
  -p "$(ls /dev/cu.usbserial* /dev/cu.wchusbserial* 2>/dev/null | head -1)" firmware/genesis_totp
```
If the ILI9341 colors look red/blue swapped, set `DISPLAY_BGR 1` for the CYD in
`board_config.h`. If the screen is dark, confirm the backlight (GPIO21) drove HIGH.

## First-run provisioning

Easiest / most reliable — use the helper. It reads credentials from a local,
gitignored `.env` file (falling back to a hidden prompt for anything missing) and
avoids the native-USB reset gotcha below:

```bash
cp .env.example .env      # then edit .env: WIFI_SSID / WIFI_PASSWORD / TOTP_SECRET
source .venv/bin/activate
python tools/provision.py            # auto-detects the port; --port to override
```

`provision.py` auto-detects the serial device (usbmodem for Genesis, usbserial
for the CYD). It holds DTR/RTS low so it works on both the S3's native USB and
the CYD's USB-UART bridge without triggering an auto-reset.

Run it while the device is at the provisioning prompt (first boot, or after
holding the USER button / sending `p`). It sends the values to the device, then
streams the reboot + Wi-Fi + NTP logs. `.env` is never committed.

The device validates the secret decodes, saves to NVS, and reboots.

### ⚠️ Native-USB serial gotcha (ESP32-S3)

The S3's USB port is the chip's built-in USB-Serial/JTAG. If a terminal asserts
DTR/RTS on connect it **resets the chip and re-enumerates the USB device**,
which macOS reports as `OSError: [Errno 6] Device not configured`. `miniterm`
does this by default. Fixes:

- Use `tools/provision.py` (holds the lines low), **or**
- Launch miniterm without toggling them:
  `python -m serial.tools.miniterm --rts 0 --dtr 0 /dev/cu.usbmodem2101 115200`

## Runtime serial commands (115200)

| Key | Action |
|---|---|
| `p` | Re-provision (SSID / password / secret) |
| `w` | Wipe stored config and reboot |
| `s` | Print status (time valid, epoch, key length, SSID) |

## Verifying the code is correct

The secret you enter here must be the **same** base32 seed your other project
uses. To sanity-check against a known-good generator, run `oathtool`:

```bash
oathtool --totp -b "YOURBASE32SECRET"   # should match the OLED, within 30s
```
