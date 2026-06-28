"""Lambda handler for the home-office guest page.

Flow:
  1. Guest enters the current 6-digit rotating PIN (TOTP) on the static site.
  2. The site POSTs the PIN here.
  3. We load the single SecureString JSON parameter from SSM, validate the PIN
     against the shared TOTP secret, and — only if valid — return the guest-facing
     device/network details.

The TOTP secret never leaves the server. The repo and static site contain no secrets.
"""

import json
import os

import boto3
import pyotp

PARAMETER_NAME = os.environ.get("PARAMETER_NAME", "/home-office/config")

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
    # Handle CORS preflight.
    method = (event.get("requestContext", {}).get("http", {}).get("method")
              or event.get("httpMethod"))
    if method == "OPTIONS":
        return _response(200, {"ok": True})

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

    # PIN is valid — return only the guest-facing details, never the TOTP secret.
    guest = config.get("guest", {})
    return _response(200, {"guest": guest})
