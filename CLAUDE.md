# CLAUDE.md

Guidance for working in this repo.

## What this is

`home-office` is a **public** website that tells guests how to use the basement
home office (Dell monitor, Vivo standing desk, Logitech MX keyboard/mouse, WiFi,
Sonos, and Home Assistant lights). It's live at **home-office.jack-roberts.com**;
a QR code on the desk links to it.

**UI:** after the page loads it shows a grid of six large icon tiles (one per
device). Tapping a tile opens a centered modal (`<dialog>`) with short numbered
steps and a "Full manual" link. The frontend is a single-page tile grid + modal —
see `render()` and the `SECTIONS` registry in `site/app.js`.

**Security model — only WiFi is gated.** Device instructions (Monitor, Desk,
Keyboard/Mouse, Speakers, Lights) are **public**: no code needed. **Only WiFi**
sits behind a rotating **TOTP PIN** (RFC 6238 — the same algorithm Google
Authenticator uses). The WiFi tile shows a lock badge; tapping it prompts for the
current 6-digit code, which the Lambda validates before returning WiFi details.
Two protections back this up: the PIN rotates every 30s, and the unlock endpoint
is rate-limited (see Architecture).

## Golden rule: no secrets in this repo

The repo and the static site are public. **Every sensitive value** (WiFi password,
the shared TOTP secret; other device info is not secret) lives in a **single
encrypted SSM `SecureString` parameter**, `/home-office/config`. Secrets exist
only in Parameter Store, in Lambda memory at request time, and physically on the
ESP32. The public `GET /guide` response is built to **exclude the `wifi` block and
the `totp_secret`**; WiFi is only ever returned by the PIN-gated `POST /unlock`.
Never commit a secret, and never add one to `site/`.

Files that could hold secrets are gitignored: `.env`, `secrets.json`,
`parameter.json`, `esp32/secrets.h`. `.env.example` is the tracked template.

## Architecture

```
Guest ──▶ CloudFront (home-office.jack-roberts.com) ──▶ S3 (static tile-grid site)
                                                              │
   on load:  GET /guide  (public) ─────────────┐             │ tap WiFi tile,
             → everything EXCEPT wifi           │             │ enter 6-digit PIN
                                                ▼             ▼
                                    API Gateway (HTTP API) ──▶ Lambda (one function)
                                       │  • GET /guide  → _guide()  (public)
                                       │  • POST /unlock → _unlock() (pyotp.verify)
                                       │    throttled: rate 2/s, burst 5
                                       ▼
                                  SSM SecureString JSON  (/home-office/config)
```

One Lambda serves both routes, dispatched by method+path in `handler()`.
`_guide()` returns the guest block minus `wifi`; `_unlock()` returns only `wifi`
(with a generated join-QR) after a valid PIN. Rate limiting is API Gateway stage
`RouteSettings` on `POST /unlock` — it's **global, not per-IP** (a deliberate
simplicity tradeoff). Custom domain + TLS cert + Route53 records are created by
the stack when `DomainName`/`HostedZoneId` are supplied (see Deploying).

## Layout

| Path | What |
|------|------|
| `site/` | Static frontend (HTML/CSS/JS), mobile-first tile grid + `<dialog>` modal. `config.js` is **generated at deploy time** from the API endpoint — don't hand-edit it. |
| `backend/app.py` | Python Lambda: public `_guide()` (no wifi) + PIN-gated `_unlock()` (wifi only, with QR). Also builds the WiFi-join QR (SVG, via `qrcode`, no Pillow). |
| `deploy/` | Plain CloudFormation (`app.yaml`, `github-oidc.yaml`) + scripts. See "Deploying". |
| `docs/` | `SETUP.md`, plus helpers: `make_parameter.py` (write full config interactively), `set_param.py` (upsert one field), `_env.py` (shared `.env` loader). |
| `esp32/` | The desk PIN gadget — a working hardware TOTP token (Arduino / arduino-cli, from the `genesis-mini-kit` project). Shows the live rotating code so guests can read it and unlock WiFi. `firmware/genesis_totp/` is the sketch (multi-board via `board_config.h`); `tools/provision.py` writes Wi-Fi + secret into NVS over serial. Its `TOTP_SECRET` must match the SSM `totp_secret`. |

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

Everything is one script — it builds the Lambda zip (with `pyotp` + `qrcode`),
deploys the CloudFormation stack (S3 + CloudFront + Lambda + HTTP API), generates
`site/config.js`, syncs the site, and invalidates the CDN:

```bash
./deploy/deploy.sh          # AWS_PROFILE comes from .env
```

Continuous deploy: every push to `main` runs `.github/workflows/deploy.yml`,
which runs the same script under the OIDC role. One-time setup and the full
walkthrough are in `docs/SETUP.md`.

**Custom domain** (`home-office.jack-roberts.com`): the stack takes optional
`DomainName`/`HostedZoneId` params (ACM cert + CloudFront alias + Route53
records). These are set as GitHub **repo variables** `DOMAIN_NAME` /
`HOSTED_ZONE_ID` and passed through by the workflow, so CI deploys preserve the
alias. Locally, `deploy.sh` reads the same env vars — pass them to add/keep the
domain: `DOMAIN_NAME=home-office.jack-roberts.com HOSTED_ZONE_ID=Z2YKRD5BS6GZZ6 ./deploy/deploy.sh`.
Omitting them serves on the default `*.cloudfront.net` URL only.

**Gotchas learned the hard way:**
- **Assets are served `no-cache`, on purpose.** Filenames aren't content-hashed
  (`app.js` stays `app.js`), so marking them `immutable`/long-max-age caused
  browsers to keep stale code for a year and silently break after a deploy. Keep
  everything `no-cache`; CloudFront still caches at the edge.
- **`s3 sync` skips content-unchanged files**, so a header-only change won't
  reapply — force it with `aws s3 cp --metadata-directive REPLACE` if migrating
  existing objects.
- **No fancy Unicode in `deploy/*.sh`.** A `…` right after a `$VAR` in an echo
  tripped `set -u` under some locales ("VAR: unbound variable"). Use ASCII.
- **First stack create needs the OIDC role's `apigateway:TagResource`** and,
  because `SiteBucket` is `Retain`, a failed create leaves the bucket behind —
  empty + delete it before retrying.

## Editing the config / rotating the secret

```bash
python3 docs/set_param.py totp_secret YOUR_BASE32_SECRET       # rotate the PIN secret
python3 docs/set_param.py guest.wifi.password "new-pass"       # any dotted path
python3 docs/set_param.py guest.desk.steps '["Step 1.","Step 2."]' --typed   # arrays/numbers
```

`set_param.py` reads the current config, sets one key by dotted path, writes it
back encrypted, and creates the parameter if absent — preserving all other
fields. It auto-refreshes an expired SSO token (`aws sso login`) and retries.

- **Values are stored as STRINGS by default** — correct for SSIDs (incl.
  all-digit ones), passwords, URLs, secrets. An all-digit SSID stored as a JSON
  *number* breaks the site.
- **`--typed` parses the value as JSON** — use it for numbers/bools and for the
  per-section `steps` **arrays** (the modal step lists). Without `--typed` an
  array would be stored as a plain string and render one character per step.

Config shape per device section: `model`/`room`, `steps` (array), `docs_url`;
WiFi has `ssid`/`password`/`auth`/`notes`. See `docs/parameter.example.json`.

After a config change, the Lambda caches per warm container — force a refresh
with `aws lambda update-function-configuration --function-name home-office-unlock
--description "..."`. After rotating the TOTP secret, also update Google
Authenticator and `esp32/secrets.h`.

## Testing helpers

No test framework is set up. When changing `backend/app.py` or the `docs/`
helpers, verify with a quick script (see git history for examples): the Lambda
TOTP flow can be exercised by monkeypatching the SSM client, and the helpers can
be tested against a stubbed `aws` CLI on `PATH`. `pyotp`/`boto3`/`qrcode` aren't
installed system-wide — use a venv (the system Python is externally managed /
PEP 668).

For **frontend** changes, verify in a real browser (Playwright): serve `site/`
locally with a `config.js` pointed at the live API, compute a current PIN from
the SSM `totp_secret` (`pyotp.TOTP(secret).now()`), and drive the flow. This has
repeatedly caught bugs static review missed (e.g. a numeric SSID crashing the
render, CSS `display` overriding a `[hidden]` attribute). Config edits are
SSM-only and need no deploy — just the Lambda cache refresh above.
