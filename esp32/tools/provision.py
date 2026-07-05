#!/usr/bin/env python3
"""Provision the genesis_totp device over serial.

Why this exists: the ESP32-S3's USB port is the chip's built-in USB-Serial/JTAG.
When a terminal asserts the DTR/RTS control lines on connect (miniterm does this
by default), the S3 resets and the USB device re-enumerates, which shows up on
macOS as `OSError: [Errno 6] Device not configured`. This script opens the port
with DTR/RTS held low so the device is NOT reset, and drives the provisioning
prompts directly.

Secrets: your Wi-Fi credentials and TOTP secret are read from a local, gitignored
`esp32/.env` file (see `esp32/.env.example`) and written straight to the serial
device. Any value missing from `.env` is prompted for via getpass. Nothing is
echoed or stored.

The TOTP_SECRET here MUST be the same base32 secret stored in the home-office SSM
config (`/home-office/config` -> totp_secret) that the /unlock Lambda validates
against. Read it with:
    aws ssm get-parameter --name /home-office/config --with-decryption \
      --query Parameter.Value --output text | jq -r .totp_secret

Run this only when the device is AT the provisioning prompt — i.e. it is
unprovisioned (first boot), or you held the USER button, or you sent 'p'.

Usage:
    python esp32/tools/provision.py [--port /dev/cu.usbmodem2101] [--baud 115200] [--env PATH]
"""
import argparse
import getpass
import glob
import os
import sys
import time

import serial

# The esp32/ directory (parent of esp32/tools/); the default .env lives here.
ESP32_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Serial-port node patterns across boards:
#   Genesis Mini (ESP32-S3 native USB) -> /dev/cu.usbmodem*
#   CYD 2432S028R (CP2102/CH340 bridge) -> /dev/cu.usbserial* / wchusbserial* / SLAB*
PORT_GLOBS = ["/dev/cu.usbmodem*", "/dev/cu.usbserial*",
              "/dev/cu.wchusbserial*", "/dev/cu.SLAB_USBtoUART*"]


def resolve_port(pref):
    """Return pref as-is unless it's 'auto'/missing, then pick the first match."""
    if pref and pref != "auto" and os.path.exists(pref):
        return pref
    found = []
    for pat in PORT_GLOBS:
        found += glob.glob(pat)
    if not found:
        sys.exit("No serial device found (looked for usbmodem/usbserial/wchusbserial/SLAB).")
    if len(found) > 1:
        print(f"Multiple ports found: {found} — using {found[0]} (pass --port to choose)")
    return found[0]


def load_env(path):
    """Minimal KEY=VALUE parser: ignores blanks/#comments, strips quotes."""
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            env[key.strip()] = val
    return env


def open_port(port, baud):
    """Open without asserting DTR/RTS (prevents the S3 native-USB reset)."""
    s = serial.Serial()
    s.port = port
    s.baudrate = baud
    s.timeout = 0.2
    s.dtr = False
    s.rts = False
    s.open()
    return s


def drain(s, secs=1.0):
    """Read whatever the device emits for up to `secs`, extending on activity."""
    end = time.time() + secs
    out = b""
    while time.time() < end:
        chunk = s.read(256)
        if chunk:
            out += chunk
            end = time.time() + 0.3
    return out.decode(errors="replace")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", default="auto",
                    help="serial device, or 'auto' to detect (default: auto)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--env", default=os.path.join(ESP32_DIR, ".env"),
                    help="path to .env file (default: esp32/.env)")
    ap.add_argument("--reprovision", action="store_true",
                    help="device is already provisioned & running: send 'p' to "
                         "re-enter provisioning before writing new values")
    args = ap.parse_args()
    args.port = resolve_port(args.port)

    env = load_env(args.env)
    if env:
        print(f"Loaded {len(env)} value(s) from {args.env}")
    else:
        print(f"No values loaded from {args.env} — will prompt for each.")

    # Pull from .env; fall back to a (hidden) prompt for anything missing.
    ssid = env.get("WIFI_SSID") or input("Wi-Fi SSID: ").strip()
    pw = env.get("WIFI_PASSWORD") or getpass.getpass("Wi-Fi password: ")
    sec = (env.get("TOTP_SECRET") or getpass.getpass("Base32 TOTP secret: ")).strip()

    print(f"\nOpening {args.port} @ {args.baud} (DTR/RTS held low, no reset)...")
    s = open_port(args.port, args.baud)
    time.sleep(0.3)
    pre = drain(s, 1.0)
    if pre.strip():
        print("device:", pre.strip())

    if args.reprovision:
        # Firmware's loop() re-enters provisioning on a single 'p' char.
        s.write(b"p")
        s.flush()
        deadline = time.time() + 4
        buf = ""
        while time.time() < deadline:
            buf += drain(s, 0.5)
            if "SSID" in buf or "PROVISION" in buf:
                break
        if buf.strip():
            print("device:", buf.strip())

    for value in (ssid, pw, sec):
        s.write((value + "\n").encode())
        s.flush()
        time.sleep(0.4)
        resp = drain(s, 1.0)          # shows the device's NEXT prompt, not our input
        if resp.strip():
            print("device:", resp.strip())

    print("\nSent. Device saves + reboots; watching Wi-Fi/NTP (Ctrl-C to stop)...")
    try:
        s.close()
    except Exception:
        pass

    # After ESP.restart() the USB port re-enumerates; reconnect and stream logs.
    deadline = time.time() + 15
    s = None
    while time.time() < deadline:
        try:
            s = open_port(args.port, args.baud)
            break
        except Exception:
            time.sleep(0.5)
    if s is None:
        print("Could not reopen port after reboot — open a monitor manually.")
        return

    try:
        end = time.time() + 30
        while time.time() < end:
            chunk = s.read(256)
            if chunk:
                sys.stdout.write(chunk.decode(errors="replace"))
                sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        s.close()
    print("\n(done watching — the OLED should now show the rolling code)")


if __name__ == "__main__":
    main()
