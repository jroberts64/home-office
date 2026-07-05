/*
 * genesis_totp — a single-account hardware TOTP token (like Google Authenticator).
 *
 *   - Stores ONE base32 TOTP secret in NVS flash (provisioned once over serial).
 *   - Syncs UTC time from NTP over Wi-Fi.
 *   - Generates the rolling RFC 6238 6-digit code and shows it on the board's
 *     TFT with a 30s countdown bar.
 *
 * Multi-board: see board_config.h. Supported targets:
 *   - Axiometa Genesis Mini (ESP32-S3) + ST7735S 160x80  [FQBN axiometa_genesis_mini]
 *   - ESP32-2432S028R "CYD"  (ESP32-WROOM) + ILI9341 240x320  [FQBN esp32:esp32:esp32]
 *
 * Provisioning (first boot, or hold the button at boot, or send 'p' over serial):
 *   prompts over serial for Wi-Fi SSID, Wi-Fi password, and the base32 secret.
 *   Nothing secret is stored in this source file.
 */

#include "board_config.h"

#include <Preferences.h>
#include <WiFi.h>
#include <time.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#if USE_ST7735
  #include <Adafruit_ST7735.h>
#elif USE_ILI9341
  #include <Adafruit_ILI9341.h>
#endif
#include "mbedtls/md.h"

// ---- Display object (board-specific bus + driver) ----------------------------
#if USE_ST7735
  SPIClass        tftSPI(FSPI);
  Adafruit_ST7735 display = Adafruit_ST7735(&tftSPI, TFT_CS, TFT_DC, TFT_RST);
#elif USE_ILI9341
  SPIClass         tftSPI(HSPI);
  Adafruit_ILI9341 display = Adafruit_ILI9341(&tftSPI, TFT_DC, TFT_CS, TFT_RST);
#endif

// Set to 1 (ST7735/Genesis only) to cycle CS/DC/RST arrangements on screen.
#define PIN_HUNT  0

// RGB565 builder. Some panels are BGR-ordered — swap R/B when DISPLAY_BGR.
static inline uint16_t C(uint8_t r, uint8_t g, uint8_t b) {
#if DISPLAY_BGR
  return ((uint16_t)(b & 0xF8) << 8) | ((uint16_t)(g & 0xFC) << 3) | (r >> 3);
#else
  return ((uint16_t)(r & 0xF8) << 8) | ((uint16_t)(g & 0xFC) << 3) | (b >> 3);
#endif
}

// ---- TOTP parameters (Google Authenticator defaults) -------------------------
static const uint32_t TOTP_PERIOD = 30;   // seconds per code
static const uint8_t  TOTP_DIGITS = 6;

// ---- Globals -----------------------------------------------------------------
Preferences prefs;
String   g_ssid, g_pass, g_secretB32;
uint8_t  g_key[64];            // decoded secret bytes
size_t   g_keyLen = 0;
bool     g_timeValid = false;

// =============================================================================
// Base32 (RFC 4648) decode — returns number of bytes written, 0 on error.
// =============================================================================
static size_t base32Decode(const String &in, uint8_t *out, size_t outCap) {
  int buffer = 0, bitsLeft = 0;
  size_t count = 0;
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == ' ' || c == '-' || c == '=' || c == '\r' || c == '\n') continue;
    int val;
    if      (c >= 'A' && c <= 'Z') val = c - 'A';
    else if (c >= 'a' && c <= 'z') val = c - 'a';
    else if (c >= '2' && c <= '7') val = c - '2' + 26;
    else return 0;  // invalid character
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      if (count >= outCap) return 0;
      out[count++] = (buffer >> bitsLeft) & 0xFF;
    }
  }
  return count;
}

// =============================================================================
// TOTP: HMAC-SHA1 over the 8-byte big-endian time counter, dynamic truncation.
// =============================================================================
static uint32_t computeTOTP(uint64_t unixTime) {
  uint64_t counter = unixTime / TOTP_PERIOD;
  uint8_t msg[8];
  for (int i = 7; i >= 0; i--) { msg[i] = counter & 0xFF; counter >>= 8; }

  uint8_t hash[20];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA1);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, info, 1 /* HMAC */);
  mbedtls_md_hmac_starts(&ctx, g_key, g_keyLen);
  mbedtls_md_hmac_update(&ctx, msg, sizeof(msg));
  mbedtls_md_hmac_finish(&ctx, hash);
  mbedtls_md_free(&ctx);

  int offset = hash[19] & 0x0F;
  uint32_t bin = ((uint32_t)(hash[offset]     & 0x7F) << 24) |
                 ((uint32_t)(hash[offset + 1] & 0xFF) << 16) |
                 ((uint32_t)(hash[offset + 2] & 0xFF) <<  8) |
                 ((uint32_t)(hash[offset + 3] & 0xFF));
  uint32_t mod = 1;
  for (int i = 0; i < TOTP_DIGITS; i++) mod *= 10;
  return bin % mod;
}

// =============================================================================
// Provisioning over serial
// =============================================================================
static String readLine(const char *prompt) {
  Serial.print(prompt);
  String s;
  while (true) {
    while (!Serial.available()) delay(5);
    char c = Serial.read();
    // Accept CR, LF, or CRLF as the terminator; swallow leading/leftover CR/LF.
    if (c == '\r' || c == '\n') { if (s.length() == 0) continue; break; }
    if (c == 8 || c == 127) { if (s.length()) s.remove(s.length() - 1); continue; }
    s += c;
  }
  s.trim();
  Serial.println();
  return s;
}

static void provision() {
  Serial.println(F("\n=== PROVISION ==="));
  String ssid   = readLine("Wi-Fi SSID: ");
  String pass   = readLine("Wi-Fi password: ");
  String secret = readLine("Base32 TOTP secret: ");

  uint8_t tmp[64];
  size_t n = base32Decode(secret, tmp, sizeof(tmp));
  if (n == 0) { Serial.println(F("!! Invalid base32 secret. Aborted.")); return; }

  prefs.begin("totp", false);
  prefs.putString("ssid",   ssid);
  prefs.putString("pass",   pass);
  prefs.putString("secret", secret);
  prefs.end();
  Serial.printf("Saved. Secret decodes to %u bytes. Rebooting...\n", (unsigned)n);
  delay(500);
  ESP.restart();
}

static bool loadConfig() {
  prefs.begin("totp", true);
  g_ssid      = prefs.getString("ssid",   "");
  g_pass      = prefs.getString("pass",   "");
  g_secretB32 = prefs.getString("secret", "");
  prefs.end();
  if (g_ssid.isEmpty() || g_secretB32.isEmpty()) return false;
  g_keyLen = base32Decode(g_secretB32, g_key, sizeof(g_key));
  return g_keyLen > 0;
}

// =============================================================================
// Display
// =============================================================================
static void initDisplay() {
#if USE_ST7735
  tftSPI.begin(TFT_SCLK, TFT_MISO, TFT_MOSI, -1);
  display.initR(INITR_MINI160x80);
  display.setSPISpeed(8000000);
#elif USE_ILI9341
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH);            // backlight on
  tftSPI.begin(TFT_SCLK, TFT_MISO, TFT_MOSI, TFT_CS);
  display.begin();
#endif
  display.setRotation(TFT_ROTATION);
}

static void showMessage(const char *l1, const char *l2 = nullptr) {
  display.fillScreen(C(0, 0, 0));
  display.setTextWrap(false);
  display.setTextColor(C(255, 255, 255));
  display.setTextSize(2);
  display.setCursor(6, TFT_H / 2 - 16);
  display.print(l1);
  if (l2) { display.setCursor(6, TFT_H / 2 + 6); display.print(l2); }
}

static bool g_forceRedraw = true;   // force a full repaint on next renderCode()

// Draw only what changed — no full-screen clear — so the display never flashes.
static void renderCode(uint32_t code, uint32_t secsRemaining) {
  static uint32_t lastCode   = 0xFFFFFFFF;
  static int      lastBarW   = -1;
  static uint16_t lastBarCol = 0xDEAD;

  const uint16_t BLACK = C(0, 0, 0);
  const int headerY      = 2;
  const int headerBottom = headerY + 8 * HEADER_TEXTSIZE + 4;
  const int barBorderY   = TFT_H - BAR_THICK;
  const int barX = 1, barY = barBorderY + 1, barInnerW = TFT_W - 2, barH = BAR_THICK - 2;
  const int digitH = 8 * CODE_TEXTSIZE;
  const int digitY = headerBottom + ((barBorderY - headerBottom) - digitH) / 2;

  // One-time static chrome: header + bar border.
  if (g_forceRedraw) {
    display.fillScreen(BLACK);
    display.setTextWrap(false);
    display.setTextSize(HEADER_TEXTSIZE);
    display.setTextColor(C(0, 200, 255));
    display.setCursor(2, headerY);
    display.print(F("TOTP TOKEN"));
    display.setTextColor(g_timeValid ? C(0, 255, 0) : C(255, 0, 0));
    display.setCursor(TFT_W - (3 * 6 * HEADER_TEXTSIZE) - 2, headerY);
    display.print(g_timeValid ? F("NTP") : F("---"));
    display.drawRect(0, barBorderY, TFT_W, BAR_THICK, C(255, 255, 255));
    lastCode = 0xFFFFFFFF; lastBarW = -1; lastBarCol = 0xDEAD;
    g_forceRedraw = false;
  }

  // Digits: repaint only when the code rolls over.
  if (code != lastCode) {
    char buf[8];
    snprintf(buf, sizeof(buf), "%06u", code);
    display.fillRect(0, headerBottom, TFT_W, barBorderY - headerBottom, BLACK);
    display.setTextSize(CODE_TEXTSIZE);
    display.setTextColor(C(255, 255, 255));
    int16_t x1, y1; uint16_t w, h;
    display.getTextBounds(buf, 0, 0, &x1, &y1, &w, &h);
    display.setCursor((TFT_W - w) / 2, digitY);
    display.print(buf);
    lastCode = code;
  }

  // Countdown bar: touch only the strip, and only the part that changed.
  uint16_t barColor = (secsRemaining <= 5) ? C(255, 0, 0) : C(0, 255, 0);
  int barW = (int)((uint32_t)secsRemaining * barInnerW / TOTP_PERIOD);
  if (barColor != lastBarCol) {                  // color flip (entering last 5s)
    display.fillRect(barX, barY, barW, barH, barColor);
    display.fillRect(barX + barW, barY, barInnerW - barW, barH, BLACK);
  } else if (barW < lastBarW) {                  // shrinking: erase the tail
    display.fillRect(barX + barW, barY, lastBarW - barW, barH, BLACK);
  } else if (barW > lastBarW) {                  // new window: grow the fill
    display.fillRect(barX, barY, barW, barH, barColor);
  }
  lastBarW = barW; lastBarCol = barColor;
}

// ---- Status RGB LED (board-specific) -----------------------------------------
static void setRGB(uint8_t r, uint8_t g, uint8_t b) {
#if RGB_NEOPIXEL
  rgbLedWrite(RGB_PIN, r, g, b);
#elif RGB_3PIN
  pinMode(RGB_R, OUTPUT); pinMode(RGB_G, OUTPUT); pinMode(RGB_B, OUTPUT);
  digitalWrite(RGB_R, r ? LOW : HIGH);   // common-anode: LOW = on
  digitalWrite(RGB_G, g ? LOW : HIGH);
  digitalWrite(RGB_B, b ? LOW : HIGH);
#endif
}

// ---- Pin-hunt diagnostic (ST7735/Genesis only) -------------------------------
#if PIN_HUNT && USE_ST7735
static void pinHunt() {
  const uint8_t perms[6][3] = {
    {3, 4, 2}, {3, 2, 4}, {4, 3, 2}, {4, 2, 3}, {2, 3, 4}, {2, 4, 3}
  };
  const uint16_t colors[6] = {ST77XX_RED, ST77XX_GREEN, ST77XX_BLUE,
                              ST77XX_YELLOW, ST77XX_CYAN, ST77XX_MAGENTA};
  while (true) {
    for (int p = 0; p < 6; p++) {
      uint8_t cs = perms[p][0], dc = perms[p][1], rst = perms[p][2];
      Serial.printf("PERM %d: CS=IO%u DC=IO%u RST=IO%u\n", p + 1, cs, dc, rst);
      Adafruit_ST7735 *t = new Adafruit_ST7735(&tftSPI, cs, dc, rst);
      t->initR(INITR_MINI160x80);
      t->setSPISpeed(8000000);
      t->setRotation(3);
      t->fillScreen(colors[p]);
      t->setTextColor(ST77XX_BLACK);
      t->setTextSize(5);
      t->setCursor(55, 20);
      t->print(p + 1);
      delete t;
      delay(3500);
    }
  }
}
#endif

// =============================================================================
// Setup / loop
// =============================================================================
void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);
  Serial.printf("\ngenesis_totp on %s\n", BOARD_NAME);

  pinMode(BTN_PIN, INPUT_PULLUP);
  setRGB(20, 0, 0);  // dim red: not ready

  initDisplay();

#if PIN_HUNT && USE_ST7735
  pinHunt();  // never returns
#endif

  showMessage("TOTP token", "starting...");

  bool haveConfig = loadConfig();

  bool btnHeld = (digitalRead(BTN_PIN) == LOW);
  if (!haveConfig || btnHeld) {
    showMessage(haveConfig ? "Reprovision" : "Needs setup", "serial 115200");
    provision();
    while (!loadConfig()) provision();
  }

  showMessage("Wi-Fi:", g_ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(g_ssid.c_str(), g_pass.c_str());
  t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    setRGB(20, 20, 0);  // amber: syncing
    showMessage("Syncing", "time (NTP)...");
    configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC (TOTP uses UTC epoch)
    struct tm tm;
    if (getLocalTime(&tm, 15000)) g_timeValid = true;
  } else {
    Serial.println(F("!! Wi-Fi failed — cannot get time. Hold button to reprovision."));
    showMessage("Wi-Fi failed", "hold btn");
  }

  setRGB(g_timeValid ? 0 : 20, g_timeValid ? 20 : 0, 0);  // green if synced
  g_forceRedraw = true;  // repaint the TOTP UI over whatever showMessage drew
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'p') provision();
    else if (c == 'w') {
      prefs.begin("totp", false); prefs.clear(); prefs.end();
      Serial.println(F("Config wiped. Rebooting...")); delay(300); ESP.restart();
    } else if (c == 's') {
      time_t now = time(nullptr);
      Serial.printf("board=%s timeValid=%d epoch=%ld keyLen=%u ssid=%s\n",
                    BOARD_NAME, g_timeValid, (long)now, (unsigned)g_keyLen,
                    g_ssid.c_str());
    } else if (c == 'd') {
      display.fillScreen(C(0, 0, 0));
      display.setTextSize(CODE_TEXTSIZE >= 5 ? 4 : 3);
      display.setTextColor(C(0, 255, 0));
      display.setCursor(10, 8);  display.print(F("DISPLAY"));
      display.setTextColor(C(255, 255, 0));
      display.setCursor(10, 8 + 8 * (CODE_TEXTSIZE >= 5 ? 4 : 3) + 6);
      display.print(F("OK 8888"));
      g_forceRedraw = true;
      Serial.println(F("Sent test pattern"));
    }
  }

  if (digitalRead(BTN_PIN) == LOW) {
    delay(50);
    if (digitalRead(BTN_PIN) == LOW) provision();
  }

  if (!g_timeValid) { delay(200); return; }

  time_t now = time(nullptr);
  uint32_t secsRemaining = TOTP_PERIOD - (now % TOTP_PERIOD);
  uint32_t code = computeTOTP((uint64_t)now);
  renderCode(code, secsRemaining);

  delay(200);
}
