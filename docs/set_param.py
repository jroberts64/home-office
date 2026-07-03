#!/usr/bin/env python3
"""Upsert a single entry in the home-office SSM config JSON.

Reads the current SecureString parameter, sets one key (by dotted path),
and writes the whole thing back — encrypted. Creates the parameter if it
doesn't exist yet. Every other field is preserved.

Values are stored as STRINGS by default — correct for SSIDs, passwords, URLs,
and secrets, including all-digit ones (an all-digit SSID stored as a number
breaks the site). Pass --typed to parse the value as JSON (number/bool/null).

Usage:
    python3 set_param.py <dotted.key.path> <value> [--typed]

Examples:
    python3 set_param.py totp_secret JBSWY3DPEHPK3PXP
    python3 set_param.py guest.wifi.ssid 6787564891          # stored as "6787564891"
    python3 set_param.py guest.wifi.password "hunter2"
    python3 set_param.py guest.home_assistant.url http://homeassistant.local:8123
    python3 set_param.py some.count 5 --typed                # stored as the number 5

Auth: inherits your environment like the AWS CLI (AWS_PROFILE/AWS_REGION come
from .env by default — see docs/_env.py). If the SSO token has expired, the
script runs `aws sso login` for you and retries once — no need to log in first.
Override the SSO session name with SSO_SESSION (default: personal-sso) and the
parameter name with PARAMETER_NAME.
"""

import json
import os
import subprocess
import sys

from _env import load_dotenv

# Pull AWS_PROFILE / AWS_REGION from the repo-local .env for local runs
# (no-op in CI, and never overrides an already-set variable).
load_dotenv()

PARAMETER_NAME = os.environ.get("PARAMETER_NAME", "/home-office/config")


# Substrings the AWS CLI emits when the SSO/session token is expired or missing.
_EXPIRED_TOKEN_MARKERS = (
    "Token has expired",
    "session associated with this profile has expired",
    "Error loading SSO Token",
    "sso session associated with this profile has expired",
    "The security token included in the request is expired",
    "ExpiredToken",
    "ForbiddenException",  # SSO token refresh failed
)


def _looks_expired(stderr):
    low = stderr.lower()
    return any(m.lower() in low for m in _EXPIRED_TOKEN_MARKERS)


def _sso_login():
    """Refresh credentials via `aws sso login`. Returns True on success.

    Prefers the SSO session name (SSO_SESSION env or the personal-sso default);
    falls back to the profile. Opens a browser for re-auth.
    """
    session = os.environ.get("SSO_SESSION", "personal-sso")
    profile = os.environ.get("AWS_PROFILE")
    attempts = []
    if session:
        attempts.append(["aws", "sso", "login", "--sso-session", session])
    if profile:
        attempts.append(["aws", "sso", "login", "--profile", profile])
    attempts.append(["aws", "sso", "login"])  # last resort: default config

    for cmd in attempts:
        print(f"==> Credentials expired; running: {' '.join(cmd)}", file=sys.stderr)
        # No capture — the CLI needs the terminal/browser for the login flow.
        if subprocess.run(cmd).returncode == 0:
            return True
    return False


def _aws(*args, _allow_refresh=True):
    """Run an aws CLI command, returning (returncode, stdout, stderr).

    If the call fails because the SSO token has expired, transparently run
    `aws sso login` once and retry.
    """
    cmd = ["aws"] + list(args)
    if os.environ.get("AWS_REGION"):
        cmd += ["--region", os.environ["AWS_REGION"]]
    # AWS_PROFILE is honored by the CLI directly; no need to pass --profile.
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 and _allow_refresh and _looks_expired(proc.stderr):
        if _sso_login():
            return _aws(*args, _allow_refresh=False)  # retry once, no further refresh
    return proc.returncode, proc.stdout, proc.stderr


def load_config():
    """Fetch and parse the current config JSON, or {} if the parameter is absent."""
    rc, out, err = _aws("ssm", "get-parameter", "--name", PARAMETER_NAME,
                        "--with-decryption", "--query", "Parameter.Value",
                        "--output", "text")
    if rc != 0:
        if "ParameterNotFound" in err:
            return {}, False  # doesn't exist yet — we'll create it
        sys.exit(f"Failed to read {PARAMETER_NAME}:\n{err.strip()}")
    try:
        return json.loads(out), True
    except json.JSONDecodeError:
        sys.exit(f"Existing value of {PARAMETER_NAME} is not valid JSON; refusing to overwrite blindly.")


def coerce(value):
    """Parse the CLI arg into a JSON scalar. Only used with --typed.

    NOT the default: every value this config holds (SSIDs, passwords, URLs,
    secrets, instructions) is a string, and silently turning an all-digit SSID
    or password into a JSON number breaks the site. Opt in with --typed only
    when you genuinely want a number/bool/null.
    """
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    if value.lower() in ("null", "none"):
        return None
    for cast in (int, float):
        try:
            return cast(value)
        except ValueError:
            pass
    return value


def set_path(config, dotted, value):
    """Set config[a][b][c] = value for a dotted path 'a.b.c', creating dicts as needed."""
    keys = dotted.split(".")
    node = config
    for k in keys[:-1]:
        existing = node.get(k)
        if not isinstance(existing, dict):
            node[k] = {}  # create or replace a non-dict with a container
        node = node[k]
    node[keys[-1]] = value


def write_config(config):
    rc, _, err = _aws("ssm", "put-parameter", "--name", PARAMETER_NAME,
                     "--type", "SecureString", "--overwrite",
                     "--value", json.dumps(config))
    if rc != 0:
        sys.exit(f"Failed to write {PARAMETER_NAME}:\n{err.strip()}")


def main():
    args = [a for a in sys.argv[1:] if a != "--typed"]
    typed = "--typed" in sys.argv[1:]
    if len(args) != 2:
        sys.exit(__doc__)
    dotted, raw_value = args

    # Store as a string by default (correct for SSIDs, passwords, URLs, secrets).
    # --typed opts into JSON coercion (numbers/booleans/null).
    value = coerce(raw_value) if typed else raw_value

    config, existed = load_config()
    set_path(config, dotted, value)
    write_config(config)

    action = "Updated" if existed else "Created"
    print(f"{action} {PARAMETER_NAME}: set '{dotted}'.")
    if not existed:
        print("Note: created with only this key. Populate the rest with docs/make_parameter.py "
              "or additional set_param.py calls.")


if __name__ == "__main__":
    main()
