"""Minimal .env loader for the home-office helper scripts.

No external dependency (python-dotenv isn't installed). Loads KEY=VALUE lines
from the repo-root .env into os.environ, WITHOUT clobbering values already set
in the environment — so explicit `AWS_PROFILE=foo python3 ...` and CI (which has
no .env) are unaffected.
"""

import os


def load_dotenv(path=None):
    if path is None:
        # Repo root is the parent of this file's directory (docs/).
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if not os.path.isfile(path):
        return
    with open(path) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if not line or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key, val = key.strip(), val.strip()
            if key and key not in os.environ:
                os.environ[key] = val
