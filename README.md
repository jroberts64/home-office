# home-office

A small public website that tells guests how to use my basement home office — how to
connect to the monitor, standing desk, keyboard/mouse, WiFi, Sonos, and how to control the
lights through Home Assistant.

The repo is **public**, so it contains **no secrets**. Anything sensitive (WiFi password,
Home Assistant URL/login, device details, and the TOTP shared secret) lives **encrypted** in
a single JSON parameter in **AWS SSM Parameter Store** (`SecureString`). The static site
fetches it through a Lambda **only after a valid rotating PIN is supplied**.

## The rotating PIN

Access is gated by a **TOTP** code (RFC 6238 — the same algorithm Google Authenticator uses).
A QR code on the desk links to the site; the guest enters the current 6-digit PIN to unlock
the details. The PIN rotates every 30 seconds.

The TOTP secret is shared between:
- the **Lambda** (validates the PIN guests type), and
- an **ESP32** desk gadget (a fun side project that displays the current PIN — see [`esp32/`](esp32/)).

## Architecture

```
  Guest phone ──scan QR──▶ CloudFront ──▶ S3 (static site)
                                │
                                ├─ enters 6-digit TOTP PIN
                                ▼
                          API Gateway ──▶ Lambda
                                              │ validate PIN (pyotp)
                                              ▼
                                      SSM Parameter Store
                                      (single SecureString JSON)
```

| Path        | What it is                                                        |
|-------------|-------------------------------------------------------------------|
| [`site/`](site/)    | Static, mobile-first frontend (HTML/CSS/JS). Public, no secrets.   |
| [`backend/`](backend/) | Python Lambda: validates TOTP, returns the decrypted JSON.        |
| [`infra/`](infra/)   | AWS SAM/CloudFormation template for the whole stack.              |
| [`esp32/`](esp32/)   | ESP32 firmware that shows the live PIN (optional, for fun).        |
| [`docs/`](docs/)    | Setup notes, including how to populate Parameter Store.            |

## Quick start

See [docs/SETUP.md](docs/SETUP.md) for full deployment steps. In short:

1. Generate a TOTP secret and write the single JSON parameter to SSM (see setup doc).
2. `sam build && sam deploy --guided` from [`infra/`](infra/).
3. Upload [`site/`](site/) to the S3 bucket the stack creates.
4. Print the QR code (the deploy outputs the URL) and stick it on the desk.

## Security model

- The repo and the static site are public; neither contains secrets.
- Secrets only ever exist in Parameter Store and in Lambda memory at request time.
- A correct TOTP PIN is required before the Lambda returns anything.
- The TOTP secret never leaves the server side (and the ESP32, which you control physically).
