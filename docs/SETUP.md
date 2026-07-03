# Setup & Deployment

Everything sensitive lives in **one** SSM `SecureString` parameter. Nothing secret is
ever committed to this public repo.

## Prerequisites

- AWS CLI configured (SSO: `aws sso login --sso-session personal-sso`)
- Python 3.12 (for the helper scripts) and `jq` if you edit JSON by hand
- `zip` on PATH (used by `deploy.sh` to package the Lambda)

## 0. Local environment (.env)

Copy the template so the scripts know which AWS profile to use locally:

```bash
cp .env.example .env    # sets AWS_PROFILE=personal-sso, AWS_REGION=us-east-1
```

`.env` is gitignored. It's loaded automatically by `deploy/*.sh` and the Python
helpers in `docs/`, and it never overrides a variable you set explicitly on the
command line. In CI there is no `.env` — the OIDC role provides credentials.

## 1. Generate the TOTP secret and write the parameter

The helper script generates a fresh base32 TOTP secret, drops it into a copy of the
example config, and writes the whole thing to Parameter Store as a `SecureString`.

```bash
cd docs
python3 -m pip install pyotp qrcode    # one-time, for the helper
python3 make_parameter.py
```

It will:
- generate a TOTP secret,
- print an `otpauth://` URL and a QR code you can scan into Google Authenticator
  (or flash into the ESP32 — see [../esp32/](../esp32/)),
- prompt you for the WiFi password, Home Assistant URL/login, etc.,
- write `/home-office/config` to SSM as an encrypted `SecureString`.

You can also do it by hand: copy `parameter.example.json`, fill it in, then:

```bash
aws ssm put-parameter \
  --name /home-office/config \
  --type SecureString \
  --value file://parameter.json \
  --overwrite
```

> `parameter.json` is gitignored. Delete it after uploading — SSM is the source of truth.

## 2. Deploy

One script does everything: builds the Lambda zip (with `pyotp`), deploys the
CloudFormation app stack (S3 + CloudFront + Lambda + HTTP API), generates
`site/config.js` from the API endpoint, syncs the site, and invalidates the CDN.

```bash
aws sso login --sso-session personal-sso       # refresh credentials
AWS_PROFILE=personal-sso ./deploy/deploy.sh
```

Stack name defaults to `home-office-app`; the site bucket is
`home-office-<accountid>`. The script prints `SiteURL` and `ApiEndpoint` at the end.
It reads all ids from CloudFormation outputs — nothing is hard-coded, and you
never edit `config.js` by hand (it's generated each deploy).

### Continuous deploy (GitHub Actions, OIDC)

To deploy automatically on every push to `main` — no AWS secrets stored in GitHub:

```bash
# One-time: create the repo-scoped deploy role. The OIDC provider already exists
# in the account (from bin-builder), so CreateOIDCProvider defaults to false.
AWS_PROFILE=personal-sso ./deploy/bootstrap-oidc.sh
```

Copy the printed `DeployRoleArn` into the repo variable **`AWS_DEPLOY_ROLE_ARN`**
(GitHub → Settings → Secrets and variables → Actions → Variables). After that,
`git push` to `main` deploys via [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

> **Pushing as the right account.** This repo lives under `jroberts64`. If your
> `gh` active account is sometimes a work account, run `./deploy/setup-git-account.sh`
> once — it pins push/commit identity to `jroberts64` for this repo only (local
> `.git/config`, no global changes).

## 3. Make the desk QR code

The QR code should point at `SiteURL`. Quick way:

```bash
python3 -c "import qrcode; qrcode.make('<SiteURL>').save('desk-qr.png')"
```

Print it, stick it on the desk. Guests scan it, type the rotating PIN, done.

## Rotating / updating secrets

To change **one field** without touching the rest of the config, use `set_param.py`.
It reads the current parameter, sets one key by dotted path, and writes it back
encrypted. It **creates** the parameter if it doesn't exist yet.

```bash
# Rotate the shared TOTP secret (keeps WiFi, HA creds, etc. intact):
python3 docs/set_param.py totp_secret YOUR_BASE32_SECRET

# Update a nested value:
python3 docs/set_param.py guest.wifi.password "new-wifi-pass"
```

It inherits `AWS_PROFILE` / `AWS_REGION` from your environment like the AWS CLI.

To rewrite the **whole** config interactively, re-run `make_parameter.py` instead.

After any change: the Lambda reads SSM on a cold start and caches per-container, so
changes propagate within a few minutes — or force it immediately by updating the
function config (see the `update-function-configuration` note in the deploy docs).
If you rotated the TOTP secret, also update Google Authenticator and `esp32/secrets.h`.
