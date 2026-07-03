"""Lambda handler for the home-office guest page.

Flow:
  1. Guest enters the current 6-digit rotating PIN (TOTP) on the static site.
  2. The site POSTs the PIN here.
  3. We load the single SecureString JSON parameter from SSM, validate the PIN
     against the shared TOTP secret, and — only if valid — return the guest-facing
     device/network details.

The TOTP secret never leaves the server. The repo and static site contain no secrets.
"""

import base64
import io
import json
import os

import boto3
import pyotp
import qrcode
import qrcode.image.svg

PARAMETER_NAME = os.environ.get("PARAMETER_NAME", "/home-office/config")


def _wifi_qr_escape(value):
    """Escape a value for the WIFI: QR payload (\\, ;, ,, :, and " are special)."""
    out = []
    for ch in str(value):
        if ch in ("\\", ";", ",", ":", '"'):
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def _wifi_qr_data_uri(ssid, password, auth="WPA"):
    """Build a scannable WiFi-join QR as an SVG data URI.

    Phones (iOS/Android camera) read the standard `WIFI:` payload and offer to
    join the network — the guest never sees the password. SVG output uses no
    Pillow / binary dependency, keeping the Lambda package light.
    """
    if not ssid:
        return None
    payload = (
        f"WIFI:T:{auth};S:{_wifi_qr_escape(ssid)};"
        f"P:{_wifi_qr_escape(password or '')};;"
    )
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(payload)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(image_factory=qrcode.image.svg.SvgPathImage).save(buf)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return "data:image/svg+xml;base64," + b64

# Reuse the SSM client across warm invocations.
_ssm = boto3.client("ssm")
_cached_config = None


def _load_config():
    """Fetch and cache the decrypted JSON parameter from SSM Parameter Store."""
    global _cached_config
    if _cached_config is None:
        resp = _ssm.get_parameter(Name=PARAMETER_NAME, WithDecryption=True)
        _cached_config = json.loads(resp["Parameter"]["Value"])
    return _cached_config


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            # CORS is handled at API Gateway; these are belt-and-suspenders.
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(body),
    }


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method")
              or event.get("httpMethod"))
    path = (event.get("requestContext", {}).get("http", {}).get("path")
            or event.get("rawPath") or event.get("path") or "")

    # CORS preflight for any route.
    if method == "OPTIONS":
        return _response(200, {"ok": True})

    # Public: everything EXCEPT WiFi. No PIN required.
    if method == "GET" and path.endswith("/guide"):
        return _guide()

    # Gated + rate-limited: WiFi only, requires a valid rotating PIN.
    if method == "POST" and path.endswith("/unlock"):
        return _unlock(event)

    return _response(404, {"error": "Not found"})


def _guide():
    """Public guest info — the whole guide minus the sensitive WiFi block."""
    try:
        config = _load_config()
    except Exception:  # noqa: BLE001 — never leak SSM internals to the client.
        return _response(500, {"error": "Server misconfiguration. Tell Jack."})

    guest = dict(config.get("guest", {}))
    guest.pop("wifi", None)  # WiFi is gated behind /unlock; never in the public payload.
    return _response(200, {"guest": guest})


def _unlock(event):
    """PIN-gated WiFi details. Rate-limited at the API Gateway layer."""
    try:
        body = json.loads(event.get("body") or "{}")
    except (TypeError, ValueError):
        return _response(400, {"error": "Invalid request body"})

    pin = str(body.get("pin", "")).strip()
    if not pin.isdigit() or len(pin) != 6:
        return _response(400, {"error": "Enter the 6-digit PIN from the desk."})

    try:
        config = _load_config()
    except Exception:  # noqa: BLE001 — never leak SSM internals to the client.
        return _response(500, {"error": "Server misconfiguration. Tell Jack."})

    totp_secret = config.get("totp_secret")
    if not totp_secret:
        return _response(500, {"error": "Server misconfiguration. Tell Jack."})

    totp = pyotp.TOTP(totp_secret)
    # valid_window=1 tolerates ~30s of clock drift on either side.
    if not totp.verify(pin, valid_window=1):
        return _response(401, {"error": "That PIN isn't right (or just expired). Try the current one."})

    # PIN is valid — return ONLY the WiFi block (with a join QR), never the secret.
    wifi = dict(config.get("guest", {}).get("wifi") or {})
    if wifi.get("ssid"):
        qr = _wifi_qr_data_uri(wifi.get("ssid"), wifi.get("password"),
                               wifi.get("auth", "WPA"))
        if qr:
            wifi["qr"] = qr

    return _response(200, {"wifi": wifi})
