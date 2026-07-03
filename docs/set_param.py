#!/usr/bin/env python3
"""Upsert a single entry in the home-office SSM config JSON.

Reads the current SecureString parameter, sets one key (by dotted path),
and writes the whole thing back — encrypted. Creates the parameter if it
doesn't exist yet. Every other field is preserved.

Usage:
    python3 set_param.py <dotted.key.path> <value>

Examples:
    python3 set_param.py totp_secret JBSWY3DPEHPK3PXP
    python3 set_param.py guest.wifi.password "hunter2"
    python3 set_param.py guest.home_assistant.url http://homeassistant.local:8123

Auth: inherits your environment like the AWS CLI. Set AWS_PROFILE (e.g.
personal-sso, after `aws sso login`) and optionally AWS_REGION. Override the
parameter name with PARAMETER_NAME if needed.
"""

import json
import os
import subprocess
import sys

PARAMETER_NAME = os.environ.get("PARAMETER_NAME", "/home-office/config")


def _aws(*args):
    """Run an aws CLI command, returning (returncode, stdout, stderr)."""
    cmd = ["aws"] + list(args)
    if os.environ.get("AWS_REGION"):
        cmd += ["--region", os.environ["AWS_REGION"]]
    # AWS_PROFILE is honored by the CLI directly; no need to pass --profile.
    proc = subprocess.run(cmd, capture_output=True, text=True)
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
    """Turn the string CLI arg into a JSON scalar when it clearly is one."""
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    if value.lower() in ("null", "none"):
        return None
    for cast in (int, float):
        try:
            return cast(value)
        except ValueError:
            pass
    return value  # plain string (the common case: secrets, URLs, passwords)


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
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    dotted, raw_value = sys.argv[1], sys.argv[2]

    config, existed = load_config()
    set_path(config, dotted, coerce(raw_value))
    write_config(config)

    action = "Updated" if existed else "Created"
    print(f"{action} {PARAMETER_NAME}: set '{dotted}'.")
    if not existed:
        print("Note: created with only this key. Populate the rest with docs/make_parameter.py "
              "or additional set_param.py calls.")


if __name__ == "__main__":
    main()
