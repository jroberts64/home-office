# CLAUDE.md

Guidance for working in this repo.

## What this is

`home-office` is a **public** website that tells guests how to use the basement
home office (Dell monitor, Vivo standing desk, Logitech MX keyboard/mouse, WiFi,
Sonos, and Home Assistant lights). A QR code on the desk links to the site.

**Access is gated by a rotating TOTP PIN** (RFC 6238 — the same algorithm Google
Authenticator uses). The guest enters the current 6-digit code; a Lambda validates
it and only then returns the guest details.

## Golden rule: no secrets in this repo

The repo and the static site are public. **Every sensitive value** (WiFi password,
Home Assistant URL/login, device details, and the shared TOTP secret) lives in a
**single encrypted SSM `SecureString` parameter**, `/home-office/config`. Secrets
exist only in Parameter Store, in Lambda memory at request time, and physically on
the ESP32. Never commit a secret, and never add one to `site/`.

Files that could hold secrets are gitignored: `.env`, `secrets.json`,
`parameter.json`, `esp32/secrets.h`. `.env.example` is the tracked template.

## Architecture

```
Guest phone ──scan QR──▶ CloudFront ──▶ S3 (static site, no secrets)
                              │ enters 6-digit TOTP PIN
                              ▼
                        API Gateway (HTTP API) ──▶ Lambda
                                                     │ pyotp.verify(pin)
                                                     ▼
                                              SSM SecureString JSON
```

## Layout

| Path | What |
|------|------|
| `site/` | Static frontend (HTML/CSS/JS), mobile-first. `config.js` is **generated at deploy time** from the API endpoint — don't hand-edit it. |
| `backend/app.py` | Python Lambda: validates the TOTP PIN, returns only the `guest` block (never the secret). |
| `deploy/` | Plain CloudFormation + scripts. See "Deploying". |
| `docs/` | `SETUP.md`, plus helpers: `make_parameter.py` (write full config interactively), `set_param.py` (upsert one field), `_env.py` (shared `.env` loader). |
| `esp32/` | PlatformIO firmware for an optional desk gadget that displays the live PIN. |

## Conventions

This repo follows the same **`deploy/` + GitHub-OIDC** pattern as the sibling
`bin-builder` and `flight-track` projects:

- **AWS**: account `019135476568`, region `us-east-1`. Locally, auth via
  `AWS_PROFILE=personal-sso` (run `aws sso login --sso-session personal-sso`).
- **`.env`** (gitignored) at the repo root sets `AWS_PROFILE`/`AWS_REGION` for
  local runs. It's loaded by `deploy/*.sh` (via a `load_dotenv` shell function)
  and by the Python helpers (via `docs/_env.py`). Loading **never overrides a
  variable already set in the environment**, so `FOO=bar ./script` and CI still
  win. Copy `.env.example` to `.env` to set up.
- **No AWS secrets in GitHub.** CI assumes a repo+branch-scoped IAM role via
  **GitHub OIDC**. The OIDC provider is account-wide and already exists (created
  by bin-builder) → `CreateOIDCProvider=false`.
- **GitHub account**: the repo lives under **`jroberts64`** (a personal account,
  not the work `jroberts-juicerpricing`). If `gh`'s active account is the work
  one, pushes 403. Run `./deploy/setup-git-account.sh` once to pin push/commit
  identity to `jroberts64` for this repo only (local `.git/config`).

## Deploying

Everything is one script — it builds the Lambda zip (with `pyotp`), deploys the
CloudFormation stack (S3 + CloudFront + Lambda + HTTP API), generates
`site/config.js`, syncs the site, and invalidates the CDN:

```bash
./deploy/deploy.sh          # AWS_PROFILE comes from .env
```

Continuous deploy: every push to `main` runs `.github/workflows/deploy.yml`,
which runs the same script under the OIDC role. One-time setup and the full
walkthrough are in `docs/SETUP.md`.

## Editing the config / rotating the secret

```bash
python3 docs/set_param.py totp_secret YOUR_BASE32_SECRET      # rotate the PIN secret
python3 docs/set_param.py guest.wifi.password "new-pass"      # any dotted path
```

`set_param.py` reads the current config, sets one key, writes it back encrypted,
and creates the parameter if absent — preserving all other fields. After rotating
the TOTP secret, also update Google Authenticator and `esp32/secrets.h`.

## Testing helpers

No test framework is set up. When changing `backend/app.py` or the `docs/`
helpers, verify with a quick script (see git history for examples): the Lambda
TOTP flow can be exercised by monkeypatching the SSM client, and the helpers can
be tested against a stubbed `aws` CLI on `PATH`. `pyotp`/`boto3` aren't installed
system-wide — use a venv (the system Python is externally managed / PEP 668).
