# Setup & Deployment

Everything sensitive lives in **one** SSM `SecureString` parameter. Nothing secret is
ever committed to this public repo.

## Prerequisites

- AWS CLI configured (`aws configure`)
- AWS SAM CLI (`brew install aws-sam-cli`)
- Python 3.12 (for the secret-generation helper)

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

## 2. Deploy the stack

```bash
cd ../infra
sam build
sam deploy --guided     # accept defaults; stack name e.g. home-office
```

Note the outputs: `SiteURL`, `SiteBucketName`, `ApiEndpoint`.

## 3. Wire the frontend to the API and upload it

Put the `ApiEndpoint` value into `site/config.js` (`API_BASE`), then upload:

```bash
cd ../site
# set API_BASE in config.js first
aws s3 sync . "s3://<SiteBucketName>/" --delete
```

CloudFront caches aggressively; after re-uploading you may want:

```bash
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

## 4. Make the desk QR code

The QR code should point at `SiteURL`. Quick way:

```bash
python3 -c "import qrcode; qrcode.make('<SiteURL>').save('desk-qr.png')"
```

Print it, stick it on the desk. Guests scan it, type the rotating PIN, done.

## Rotating / updating secrets

Just re-run the helper (or `put-parameter --overwrite`). The Lambda reads SSM on a cold
start and caches per-container, so changes propagate within a few minutes — or redeploy
the function to force it.
