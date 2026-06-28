#!/usr/bin/env python3
"""Interactive helper: generate a TOTP secret and write the single SSM parameter.

Run from the docs/ directory:  python3 make_parameter.py

Requires:  pip install pyotp qrcode  (and AWS CLI credentials configured)
"""

import json
import subprocess
import sys

try:
    import pyotp
except ImportError:
    sys.exit("Run: python3 -m pip install pyotp qrcode")

PARAMETER_NAME = "/home-office/config"
ISSUER = "Basement Office"
ACCOUNT = "guest"


def prompt(label, default=""):
    suffix = f" [{default}]" if default else ""
    val = input(f"{label}{suffix}: ").strip()
    return val or default


def main():
    secret = pyotp.random_base32()
    uri = pyotp.TOTP(secret).provisioning_uri(name=ACCOUNT, issuer_name=ISSUER)

    print("\n=== TOTP secret generated ===")
    print(f"Base32 secret (also goes in esp32/secrets.h): {secret}")
    print(f"otpauth URI: {uri}\n")
    try:
        import qrcode
        qr = qrcode.QRCode()
        qr.add_data(uri)
        qr.print_ascii(invert=True)
        print("^ Scan into Google Authenticator to verify it matches the site.\n")
    except ImportError:
        print("(install `qrcode` to see a scannable QR here)\n")

    print("Now fill in the guest details (press enter to keep the example default).\n")
    config = {
        "totp_secret": secret,
        "guest": {
            "wifi": {
                "ssid": prompt("WiFi SSID"),
                "password": prompt("WiFi password"),
                "notes": prompt("WiFi notes", "Same name on 2.4 and 5GHz."),
            },
            "monitor": {
                "model": prompt("Monitor model", "Dell monitor"),
                "instructions": prompt("Monitor instructions",
                                       "Plug in the USB-C cable; it switches automatically."),
            },
            "desk": {
                "model": prompt("Desk model", "Vivo standing desk"),
                "instructions": prompt("Desk instructions",
                                       "Use the up/down controller under the desktop, right side."),
            },
            "keyboard_mouse": {
                "model": prompt("Keyboard/mouse model", "Logitech MX Keys Mini + MX Master"),
                "instructions": prompt("Keyboard/mouse instructions",
                                       "Already paired to the dock via Bluetooth channel 1."),
            },
            "sonos": {
                "room": prompt("Sonos room", "Basement Office"),
                "instructions": prompt("Sonos instructions",
                                       "AirPlay or Spotify Connect to 'Basement Office'."),
            },
            "home_assistant": {
                "url": prompt("Home Assistant URL", "http://homeassistant.local:8123"),
                "login": prompt("Home Assistant login (user / pass)", "guest / changeme"),
                "instructions": prompt("Home Assistant instructions",
                                       "Open the 'Basement Office' dashboard for the lights."),
            },
        },
    }

    value = json.dumps(config)
    print("\nWriting to SSM Parameter Store as a SecureString...")
    result = subprocess.run(
        ["aws", "ssm", "put-parameter",
         "--name", PARAMETER_NAME,
         "--type", "SecureString",
         "--value", value,
         "--overwrite"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print("Failed:\n" + result.stderr)
        print("\nThe config JSON (write it yourself if needed):\n")
        print(json.dumps(config, indent=2))
        sys.exit(1)
    print(f"Done. Wrote {PARAMETER_NAME}.")
    print("Keep the base32 secret above for the ESP32. Don't commit it.")


if __name__ == "__main__":
    main()
