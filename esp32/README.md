# esp32 — the desk PIN gadget

A small hardware TOTP token that displays the **current rotating 6-digit PIN**,
so guests can read it off a device on the desk and type it into the site to
unlock the WiFi details. It works exactly like a Google Authenticator entry, in
hardware.

This firmware was proven out in the sibling `genesis-mini-kit` project and
brought here as the canonical PIN gadget for home-office. **Confirmed working
end-to-end** on the Axiometa Genesis Mini (ESP32-S3).

## The one thing that matters: the shared secret

The gadget must be seeded with the **same base32 TOTP secret** that the
home-office `/unlock` Lambda validates against — i.e. `totp_secret` in the SSM
config. If they match, the code on the screen is the code the site accepts.

```bash
# Read the live secret from SSM (needs AWS_PROFILE=personal-sso / SSO login):
aws ssm get-parameter --name /home-office/config --with-decryption \
  --query Parameter.Value --output text | jq -r .totp_secret
```

Put that value in `esp32/.env` as `TOTP_SECRET` (see [.env.example](.env.example)).
If you rotate the secret in SSM (via `docs/set_param.py totp_secret ...`), you
must re-provision the gadget too, or it will show stale codes.

## Layout

| Path | What |
|------|------|
| [`firmware/genesis_totp/`](firmware/genesis_totp/) | The Arduino firmware. `genesis_totp.ino` + `board_config.h` (multi-board). See its [README](firmware/genesis_totp/README.md) for wiring, build/flash, and hardware detail. |
| [`tools/provision.py`](tools/provision.py) | Serial provisioner — writes Wi-Fi + secret into the device's NVS from `esp32/.env`. |
| `.env.example` | Template for `esp32/.env` (Wi-Fi creds + the shared TOTP secret). |

## Quick start

Firmware is built with **arduino-cli** (not PlatformIO). The secret is stored in
the device's NVS flash — provisioned over serial, never compiled into source.

```bash
# 1. Build + flash (Genesis Mini is the default target; CYD via board_config.h)
arduino-cli compile --fqbn esp32:esp32:axiometa_genesis_mini esp32/firmware/genesis_totp
arduino-cli upload  --fqbn esp32:esp32:axiometa_genesis_mini \
  -p /dev/cu.usbmodem2101 esp32/firmware/genesis_totp

# 2. Provision Wi-Fi + secret (fill esp32/.env first)
cp esp32/.env.example esp32/.env      # edit: WIFI_SSID / WIFI_PASSWORD / TOTP_SECRET
python esp32/tools/provision.py       # auto-detects the port; --port to override
```

Full build/flash options, both board targets, the provisioning gotchas, and
runtime serial commands are in
[firmware/genesis_totp/README.md](firmware/genesis_totp/README.md).

## Verify it matches the site

The gadget's code and the site must agree. Cross-check the on-screen code against
the same secret with `oathtool`:

```bash
oathtool --totp -b "YOURBASE32SECRET"   # should match the gadget within 30s
```
